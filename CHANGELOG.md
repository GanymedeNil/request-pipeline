# Changelog

Notable changes to Request Pipeline. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

When releasing, replace `Unreleased` in the version heading with the release date (`YYYY-MM-DD`); the release workflow uses that section as the release notes.

## [1.3.0] - Unreleased

### Added

- WebSocket and EventSource (SSE) capture, off by default. Each socket open, message, error and close, and each SSE message, is forwarded as its own record (`kind: "websocket"` / `"sse"`), in order per stream.
- `kind` and `target_type` fields on HTTP records.
- A Feedback link in the popup.
- `examples/receiver.py` prints WebSocket and SSE records and adds WebSocket messages to the HAR file the way Chrome DevTools does.

### Changed

- A clearer extension description, shown in the Chrome Web Store and on `chrome://extensions`.

### Fixed

- Requests made by cross-site iframes, dedicated and shared workers, and service workers were not captured.
- EventSource streams were counted as skipped requests.

## [1.2.0] - 2026-11-16

1.1.0 was never published on its own; its fixes ship in this release.

### Added

- Start and Stop buttons in the popup, with live counts of forwarded, failed and skipped requests. The toolbar badge shows the forwarded count and turns red when forwarding fails.
- Options: reload the page when capture starts, redact credentials, choose resource types, include/exclude URL patterns, filter by HTTP method, and limit body size. All apply immediately, including to a running capture.
- New record fields: `schema_version`, `request_id`, `tab_id`, `document_url`, `resource_type`, `timestamp` and `duration_ms`.
- A warning in the popup when the server address isn't on this computer or isn't encrypted.
- `examples/receiver.py`, a ready-made receiver that prints each request and can save JSONL and HAR files.

### Changed

- Static assets are filtered by resource type instead of URL suffix. Images, fonts, media, manifests and CORS preflights are no longer forwarded by default.
- The server address is stored in `chrome.storage.local`. An address saved by 1.0.2 is moved over automatically.

### Fixed

- Changing the server address during a capture now takes effect.
- Capture keeps working after Chrome restarts the extension's service worker.
- `cookies` could be missing from a record.
- Failed requests, and requests without a response body, were never released from memory.
- Request bodies too large for Chrome to include in the event were not forwarded.
- Forwarding errors and attach errors (for example on `chrome://` pages) failed silently.

## [1.0.2] - 2024-04-04

### Fixed

- Records are sent with `Content-Type: application/json`.
- The server address is remembered between popup openings.

## [1.0.1] - 2023-02-09

### Fixed

- The URL filter threw on every request.

## [1.0.0] - 2023-01-31

First release.

[1.3.0]: https://github.com/GanymedeNil/request-pipeline/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/GanymedeNil/request-pipeline/compare/v1.0.2...v1.2.0
[1.0.2]: https://github.com/GanymedeNil/request-pipeline/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/GanymedeNil/request-pipeline/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/GanymedeNil/request-pipeline/releases/tag/v1.0.0
