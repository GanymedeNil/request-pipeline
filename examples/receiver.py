#!/usr/bin/env python3
"""Reference receiver for Request Pipeline.

Listens for the records the extension POSTs, prints one line per record, and can also save them:

    python3 examples/receiver.py                       # print only, on http://127.0.0.1:6789
    python3 examples/receiver.py --jsonl requests.jsonl  # also append each record as a JSON line
    python3 examples/receiver.py --har capture.har     # also keep a HAR file (open it in DevTools)

HTTP records become HAR entries. WebSocket messages are added to their connection's entry the way
Chrome DevTools exports them (`_webSocketMessages`). EventSource messages have no HAR form, so they
are only printed and written to JSONL.

Standard library only; Python 3.8+.
"""

import argparse
import json
import os
import sys
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qsl, urlsplit

HTTP_VERSIONS = {"http/1.0": "HTTP/1.0", "http/1.1": "HTTP/1.1", "h2": "HTTP/2", "h3": "HTTP/3"}


def header_list(headers):
    """CDP joins repeated headers with newlines; HAR wants one entry per value."""
    return [
        {"name": name, "value": value}
        for name, joined in (headers or {}).items()
        for value in str(joined).split("\n")
    ]


def find_header(headers, wanted):
    for name, value in (headers or {}).items():
        if name.lower() == wanted:
            return value
    return ""


def iso_time(record):
    ms = record.get("timestamp")
    moment = datetime.fromtimestamp(ms / 1000, tz=timezone.utc) if ms else datetime.now(timezone.utc)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def http_har_entry(record):
    """Converts an HTTP record to a HAR 1.2 entry."""
    request = record.get("request") or {}
    response = record.get("response") or {}
    body = record.get("response_body") or {}
    duration = record.get("duration_ms") or 0
    http_version = HTTP_VERSIONS.get(str(response.get("protocol", "")).lower(), "")
    cookies = [{"name": c.get("name", ""), "value": c.get("value", "")} for c in record.get("cookies") or []]

    har_request = {
        "method": request.get("method", "GET"),
        "url": request.get("url", ""),
        "httpVersion": http_version,
        "cookies": cookies,
        "headers": header_list(request.get("headers")),
        "queryString": [
            {"name": k, "value": v} for k, v in parse_qsl(urlsplit(request.get("url", "")).query, keep_blank_values=True)
        ],
        "headersSize": -1,
        "bodySize": len(request.get("postData") or ""),
    }
    if isinstance(request.get("postData"), str):
        har_request["postData"] = {
            "mimeType": find_header(request.get("headers"), "content-type"),
            "text": request["postData"],
        }

    content = {"size": -1, "mimeType": response.get("mimeType", "")}
    if isinstance(body.get("body"), str):
        content["text"] = body["body"]
        content["size"] = len(body["body"])
        if body.get("base64Encoded"):
            content["encoding"] = "base64"
    elif body.get("omitted"):
        content["comment"] = f"body omitted ({body['omitted']}, {body.get('length')} characters)"

    return {
        "startedDateTime": iso_time(record),
        "time": duration,
        "request": har_request,
        "response": {
            "status": response.get("status", 0),
            "statusText": response.get("statusText", ""),
            "httpVersion": http_version,
            "cookies": [],
            "headers": header_list(response.get("headers")),
            "content": content,
            "redirectURL": find_header(response.get("headers"), "location"),
            "headersSize": -1,
            "bodySize": -1,
        },
        "cache": {},
        "timings": {"send": 0, "wait": duration, "receive": 0},
        "_resourceType": record.get("resource_type", ""),
    }


def websocket_har_entry(record):
    """A HAR entry for a WebSocket handshake; its messages are appended to `_webSocketMessages`."""
    request = record.get("request") or {}
    response = record.get("response") or {}
    url = record.get("url", "")
    return {
        "startedDateTime": iso_time(record),
        "time": 0,
        "request": {
            "method": "GET",
            "url": url,
            "httpVersion": "HTTP/1.1",
            "cookies": [],
            "headers": header_list(request.get("headers")),
            "queryString": [{"name": k, "value": v} for k, v in parse_qsl(urlsplit(url).query, keep_blank_values=True)],
            "headersSize": -1,
            "bodySize": 0,
        },
        "response": {
            "status": response.get("status", 0),
            "statusText": response.get("statusText", ""),
            "httpVersion": "HTTP/1.1",
            "cookies": [],
            "headers": header_list(response.get("headers")),
            "content": {"size": 0, "mimeType": ""},
            "redirectURL": "",
            "headersSize": -1,
            "bodySize": -1,
        },
        "cache": {},
        "timings": {"send": 0, "wait": 0, "receive": 0},
        "_resourceType": "websocket",
        "_webSocketMessages": [],
    }


def websocket_har_message(record):
    """One `_webSocketMessages` item, in the format Chrome DevTools uses (time in epoch seconds)."""
    data = record.get("data")
    message = {
        "type": "send" if record.get("direction") == "sent" else "receive",
        "time": (record.get("timestamp") or 0) / 1000,
        "opcode": record.get("opcode", 1),
        "data": data if isinstance(data, str) else "",
    }
    if record.get("omitted"):
        message["_omitted"] = f"{record['omitted']}, {record.get('length')} characters"
    return message


def size_text(text, base64_encoded=False):
    size = len(text) * 3 // 4 if base64_encoded else len(text.encode("utf-8"))
    return f"{size / 1024:.1f} KB" if size >= 1024 else f"{size} B"


def summary(record):
    kind = record.get("kind", "http")
    if kind == "websocket":
        return websocket_summary(record)
    if kind == "sse":
        data = record.get("data")
        size = size_text(data) if isinstance(data, str) else "data omitted"
        return f"SSE         {record.get('url', '')}  (event: {record.get('event_name') or 'message'}, {size})"

    request = record.get("request") or {}
    response = record.get("response") or {}
    body = record.get("response_body") or {}
    text = body.get("body")
    if isinstance(text, str):
        body_size = size_text(text, body.get("base64Encoded"))
    else:
        body_size = "body omitted" if body.get("omitted") else "no body"
    details = [response.get("mimeType") or "?", body_size]
    if record.get("duration_ms") is not None:
        details.append(f"{record['duration_ms']} ms")
    if record.get("target_type") not in (None, "page"):
        details.append(f"from {record['target_type']}")
    return f"{response.get('status', '---'):>3} {request.get('method', '?'):<7} {request.get('url', '')}  ({', '.join(details)})"


def websocket_summary(record):
    url = record.get("url", "")
    event = record.get("event")
    if event == "open":
        return f"{(record.get('response') or {}).get('status', '---'):>3} WS      {url}  (open)"
    if event == "message":
        arrow = "->" if record.get("direction") == "sent" else "<-"
        data = record.get("data")
        kind = "binary" if record.get("opcode") == 2 else "text"
        size = size_text(data, record.get("base64Encoded")) if isinstance(data, str) else "data omitted"
        return f"    WS {arrow}   {url}  ({kind}, {size})"
    if event == "error":
        return f"    WS !    {url}  (error: {record.get('error_message', '')})"
    return f"    WS      {url}  (closed)"


class Sink:
    """Prints records and writes them to the optional JSONL / HAR files."""

    def __init__(self, jsonl_path=None, har_path=None):
        self.lock = threading.Lock()
        self.jsonl_path = jsonl_path
        self.har_path = har_path
        self.har_entries = []
        # (tab_id, request_id) of a WebSocket -> its HAR entry, for appending messages.
        self.websockets = {}
        if har_path and os.path.exists(har_path):
            with open(har_path, encoding="utf-8") as f:
                self.har_entries = json.load(f)["log"]["entries"]

    def add(self, record):
        with self.lock:
            print(summary(record), flush=True)
            if self.jsonl_path:
                with open(self.jsonl_path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(record, ensure_ascii=False) + "\n")
            if self.har_path and self._add_to_har(record):
                self._write_har()

    def _add_to_har(self, record):
        """Returns whether the HAR changed."""
        kind = record.get("kind", "http")
        if kind == "http":
            self.har_entries.append(http_har_entry(record))
            return True
        if kind == "websocket":
            socket = (record.get("tab_id"), record.get("request_id"))
            if record.get("event") == "open":
                entry = websocket_har_entry(record)
                self.websockets[socket] = entry
                self.har_entries.append(entry)
                return True
            entry = self.websockets.get(socket)
            if record.get("event") == "message" and entry is not None:
                entry["_webSocketMessages"].append(websocket_har_message(record))
                return True
            if record.get("event") == "close":
                self.websockets.pop(socket, None)
        return False

    def _write_har(self):
        har = {
            "log": {
                "version": "1.2",
                "creator": {"name": "request-pipeline receiver", "version": "1"},
                "pages": [],
                "entries": self.har_entries,
            }
        }
        # Rewritten in full after every record and swapped in atomically, so the file is always
        # valid HAR even if the receiver is stopped mid-write.
        tmp = f"{self.har_path}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(har, f, ensure_ascii=False)
        os.replace(tmp, self.har_path)


def make_handler(sink):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            try:
                record = json.loads(self.rfile.read(length))
            except ValueError as err:
                self.send_error(400, f"invalid JSON: {err}")
                return
            sink.add(record)
            self.send_response(204)
            self.end_headers()

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"Request Pipeline receiver is running. Records are POSTed here.\n")

        def log_message(self, format, *args):
            pass  # one summary line per record is printed instead

    return Handler


def main(argv=None):
    parser = argparse.ArgumentParser(description="Receive and save records from the Request Pipeline extension.")
    parser.add_argument("--host", default="127.0.0.1", help="address to listen on (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=6789, help="port to listen on (default: 6789)")
    parser.add_argument("--jsonl", metavar="FILE", help="append every record to FILE as one JSON line")
    parser.add_argument("--har", metavar="FILE", help="keep FILE up to date as a HAR 1.2 archive (adds to it if it exists)")
    args = parser.parse_args(argv)

    server = ThreadingHTTPServer((args.host, args.port), make_handler(Sink(args.jsonl, args.har)))
    host, port = server.server_address[:2]
    print(f"Listening on http://{host}:{port}  (set this as the Server Address in the extension)", file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
