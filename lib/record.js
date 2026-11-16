// Assembles the JSON records forwarded to the receiver. No chrome.* calls, so it can be unit-tested.
// See "Data format" in the README for the documented shape of each kind.

/**
 * @typedef {import('devtools-protocol').Protocol.Network.Request} CdpRequest
 * @typedef {import('devtools-protocol').Protocol.Network.Response} CdpResponse
 * @typedef {import('devtools-protocol').Protocol.Network.Cookie} CdpCookie
 * @typedef {import('devtools-protocol').Protocol.Network.WebSocketFrame} CdpWebSocketFrame
 * @typedef {import('devtools-protocol').Protocol.Network.WebSocketResponse} CdpWebSocketResponse
 * @typedef {import('devtools-protocol').Protocol.Network.EventSourceMessageReceivedEvent} CdpEventSourceMessage
 */

/**
 * Version of the record format. Records sent before 1.2 have no schema_version.
 * Bump it only for changes that break existing receivers; new fields and opt-in kinds don't.
 */
export const SCHEMA_VERSION = 1;

/**
 * What the service worker collects from the Network events of one HTTP request.
 * @typedef {object} PendingRequest
 * @property {CdpRequest} request
 * @property {string} [sessionId] Child target session the request came from; absent for the tab itself.
 * @property {string} targetType "page", "iframe", "worker", "service_worker", ...
 * @property {CdpResponse} [response]
 * @property {string} [resourceType]
 * @property {string} [documentURL]
 * @property {number} [wallTime] Seconds since the epoch when the request was sent.
 * @property {number} [startTime] Monotonic seconds when the request was sent.
 * @property {number} [endTime] Monotonic seconds when loading finished.
 */

/**
 * An open WebSocket or EventSource the service worker is following.
 * @typedef {object} StreamInfo
 * @property {'websocket' | 'sse'} kind
 * @property {string} url
 * @property {string} targetType
 * @property {string} [documentURL]
 * @property {number} [clockOffset] Seconds to add to a CDP monotonic timestamp to get epoch seconds.
 * @property {Record<string, string>} [requestHeaders] WebSocket handshake request headers.
 */

/**
 * The request as forwarded: a CDP Request, whose body may be replaced by a marker.
 * @typedef {Omit<CdpRequest, 'postData'> & {
 *   postData?: string | null,
 *   postDataOmitted?: 'too_large',
 *   postDataLength?: number,
 * }} ForwardedRequest
 */

/**
 * @typedef {object} ResponseBody
 * @property {string | null} body Null when replaced by a marker.
 * @property {boolean} base64Encoded
 * @property {'too_large'} [omitted]
 * @property {number} [length] Length of the omitted body, in characters.
 */

/**
 * One HTTP request and its response.
 * @typedef {object} HttpRecord
 * @property {number} schema_version
 * @property {'http'} kind
 * @property {string} request_id
 * @property {number} tab_id
 * @property {string} target_type
 * @property {string} [document_url]
 * @property {string} [resource_type]
 * @property {number} [timestamp] Milliseconds since the epoch when the request was sent.
 * @property {number} [duration_ms]
 * @property {ForwardedRequest} request
 * @property {CdpResponse} [response]
 * @property {CdpCookie[]} [cookies] Left out if Chrome couldn't return them.
 * @property {ResponseBody} response_body
 */

/**
 * One WebSocket event. `request`/`response` are set on "open", the message fields on "message",
 * `error_message` on "error".
 * @typedef {object} WebSocketRecord
 * @property {number} schema_version
 * @property {'websocket'} kind
 * @property {'open' | 'message' | 'error' | 'close'} event
 * @property {string} request_id
 * @property {number} tab_id
 * @property {string} target_type
 * @property {string} url
 * @property {number} timestamp Milliseconds since the epoch.
 * @property {{ headers: Record<string, string> }} [request]
 * @property {{ status: number, statusText: string, headers: Record<string, string> }} [response]
 * @property {'sent' | 'received'} [direction]
 * @property {number} [opcode] 1 = text, 2 = binary.
 * @property {string | null} [data] Text, or base64 for binary; null when replaced by a marker.
 * @property {boolean} [base64Encoded]
 * @property {'too_large'} [omitted]
 * @property {number} [length]
 * @property {string} [error_message]
 */

/**
 * One EventSource message.
 * @typedef {object} SseRecord
 * @property {number} schema_version
 * @property {'sse'} kind
 * @property {'message'} event
 * @property {string} request_id
 * @property {number} tab_id
 * @property {string} target_type
 * @property {string} url
 * @property {string} [document_url]
 * @property {number} timestamp Milliseconds since the epoch.
 * @property {string} event_name
 * @property {string} event_id
 * @property {string | null} data Null when replaced by a marker.
 * @property {'too_large'} [omitted]
 * @property {number} [length]
 */

/** @typedef {HttpRecord | WebSocketRecord | SseRecord} ForwardedRecord */

/**
 * @param {object} parts
 * @param {number} parts.tabId
 * @param {string} parts.requestId
 * @param {PendingRequest} parts.pending
 * @param {{ body: string, base64Encoded: boolean }} parts.responseBody
 * @param {CdpCookie[]} [parts.cookies]
 * @param {string} [parts.postData] The request body, when it had to be fetched separately.
 * @returns {HttpRecord}
 */
export function buildRecord({ tabId, requestId, pending, responseBody, cookies, postData }) {
    const { request, response, targetType, resourceType, documentURL, wallTime, startTime, endTime } = pending;
    return {
        schema_version: SCHEMA_VERSION,
        kind: 'http',
        request_id: requestId,
        tab_id: tabId,
        target_type: targetType,
        document_url: documentURL,
        resource_type: resourceType,
        timestamp: wallTime === undefined ? undefined : Math.round(wallTime * 1000),
        duration_ms:
            startTime === undefined || endTime === undefined ? undefined : Math.round((endTime - startTime) * 1000),
        request: postData === undefined ? request : { ...request, postData },
        response,
        ...(cookies && { cookies }),
        response_body: responseBody,
    };
}

/**
 * @typedef {object} StreamContext
 * @property {StreamInfo} stream
 * @property {number} tabId
 * @property {string} requestId
 * @property {number} [time] CDP monotonic timestamp of the event, in seconds.
 */

/**
 * @param {StreamContext} context
 * @returns {Omit<WebSocketRecord, 'event'>}
 */
function webSocketBase({ stream, tabId, requestId, time }) {
    return {
        schema_version: SCHEMA_VERSION,
        kind: 'websocket',
        request_id: requestId,
        tab_id: tabId,
        target_type: stream.targetType,
        url: stream.url,
        timestamp: wallClockMs(time, stream.clockOffset),
    };
}

/**
 * Monotonic CDP time to epoch milliseconds; falls back to now when the offset is unknown (for example
 * when the service worker restarted after the stream opened).
 * @param {number | undefined} time
 * @param {number | undefined} offset
 */
function wallClockMs(time, offset) {
    return time !== undefined && offset !== undefined ? Math.round((time + offset) * 1000) : Date.now();
}

/**
 * @param {StreamContext} context
 * @param {CdpWebSocketResponse} response
 * @returns {WebSocketRecord}
 */
export function webSocketOpenRecord(context, response) {
    return {
        ...webSocketBase(context),
        event: 'open',
        request: { headers: context.stream.requestHeaders ?? {} },
        response: { status: response.status, statusText: response.statusText, headers: response.headers },
    };
}

/**
 * @param {StreamContext} context
 * @param {'sent' | 'received'} direction
 * @param {CdpWebSocketFrame} frame
 * @returns {WebSocketRecord}
 */
export function webSocketMessageRecord(context, direction, frame) {
    return {
        ...webSocketBase(context),
        event: 'message',
        direction,
        opcode: frame.opcode,
        data: frame.payloadData,
        // CDP sends binary payloads (opcode 2) as base64.
        base64Encoded: frame.opcode === 2,
    };
}

/**
 * @param {StreamContext} context
 * @param {string} message
 * @returns {WebSocketRecord}
 */
export function webSocketErrorRecord(context, message) {
    return { ...webSocketBase(context), event: 'error', error_message: message };
}

/**
 * @param {StreamContext} context
 * @returns {WebSocketRecord}
 */
export function webSocketCloseRecord(context) {
    return { ...webSocketBase(context), event: 'close' };
}

/**
 * @param {StreamContext} context
 * @param {CdpEventSourceMessage} message
 * @returns {SseRecord}
 */
export function sseRecord({ stream, tabId, requestId, time }, message) {
    return {
        schema_version: SCHEMA_VERSION,
        kind: 'sse',
        event: 'message',
        request_id: requestId,
        tab_id: tabId,
        target_type: stream.targetType,
        url: stream.url,
        document_url: stream.documentURL,
        timestamp: wallClockMs(time, stream.clockOffset),
        event_name: message.eventName,
        event_id: message.eventId,
        data: message.data,
    };
}

/**
 * Replaces bodies and message payloads longer than `limit` characters by a marker that keeps their length.
 * @template {ForwardedRecord} R
 * @param {R} record
 * @param {number} limit 0 or less means no limit.
 * @returns {R}
 */
export function limitBodies(record, limit) {
    if (!(limit > 0)) {
        return record;
    }
    if (record.kind !== 'http') {
        const { data } = record;
        return typeof data === 'string' && data.length > limit
            ? { ...record, data: null, omitted: 'too_large', length: data.length }
            : record;
    }
    /** @type {HttpRecord} */
    const out = { ...record };
    const { postData } = record.request;
    if (typeof postData === 'string' && postData.length > limit) {
        out.request = {
            ...record.request,
            postData: null,
            postDataOmitted: 'too_large',
            postDataLength: postData.length,
        };
    }
    const { body } = record.response_body;
    if (typeof body === 'string' && body.length > limit) {
        out.response_body = { ...record.response_body, body: null, omitted: 'too_large', length: body.length };
    }
    return /** @type {R} */ (out);
}
