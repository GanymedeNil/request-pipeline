// Assembles the JSON record forwarded for each request. No chrome.* calls, so it can be unit-tested.

/**
 * @typedef {import('devtools-protocol').Protocol.Network.Request} CdpRequest
 * @typedef {import('devtools-protocol').Protocol.Network.Response} CdpResponse
 * @typedef {import('devtools-protocol').Protocol.Network.Cookie} CdpCookie
 */

/**
 * Version of the record format. Records sent before 1.2 have no schema_version.
 * Bump it only for changes that break existing receivers.
 */
export const SCHEMA_VERSION = 1;

/**
 * What the service worker collects from the Network events of one request.
 * @typedef {object} PendingRequest
 * @property {CdpRequest} request
 * @property {CdpResponse} [response]
 * @property {string} [resourceType]
 * @property {string} [documentURL]
 * @property {number} [wallTime] Seconds since the epoch when the request was sent.
 * @property {number} [startTime] Monotonic seconds when the request was sent.
 * @property {number} [endTime] Monotonic seconds when loading finished.
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
 * One forwarded record; see "Data format" in the README.
 * @typedef {object} ForwardedRecord
 * @property {number} schema_version
 * @property {string} request_id
 * @property {number} tab_id
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
 * @param {object} parts
 * @param {number} parts.tabId
 * @param {string} parts.requestId
 * @param {PendingRequest} parts.pending
 * @param {{ body: string, base64Encoded: boolean }} parts.responseBody
 * @param {CdpCookie[]} [parts.cookies]
 * @param {string} [parts.postData] The request body, when it had to be fetched separately.
 * @returns {ForwardedRecord}
 */
export function buildRecord({ tabId, requestId, pending, responseBody, cookies, postData }) {
    const { request, response, resourceType, documentURL, wallTime, startTime, endTime } = pending;
    return {
        schema_version: SCHEMA_VERSION,
        request_id: requestId,
        tab_id: tabId,
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
 * Replaces bodies longer than `limit` characters by a marker that keeps their length.
 * @param {ForwardedRecord} record
 * @param {number} limit 0 or less means no limit.
 * @returns {ForwardedRecord}
 */
export function limitBodies(record, limit) {
    if (!(limit > 0)) {
        return record;
    }
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
    return out;
}
