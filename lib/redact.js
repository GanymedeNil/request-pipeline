// Removes credentials from a record before it leaves the browser. Covers headers and cookies;
// URLs and bodies are forwarded as they are.

/** @typedef {import('./record.js').ForwardedRecord} ForwardedRecord */

export const REDACTED = '[REDACTED]';

const SENSITIVE_HEADERS = new Set([
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'x-auth-token',
    'x-csrf-token',
    'x-xsrf-token',
]);

/**
 * Returns a copy of `record` with credentials replaced by {@link REDACTED}.
 * @param {ForwardedRecord} record
 * @returns {ForwardedRecord}
 */
export function redactRecord(record) {
    const out = { ...record, request: { ...record.request, headers: redactHeaders(record.request.headers) } };
    if (record.response) {
        const response = {
            ...record.response,
            headers: redactHeaders(record.response.headers),
            requestHeaders: redactHeaders(record.response.requestHeaders),
        };
        // Raw header blocks would carry the same values unredacted.
        delete response.headersText;
        delete response.requestHeadersText;
        out.response = response;
    }
    if (record.cookies) {
        out.cookies = record.cookies.map((cookie) => ({ ...cookie, value: REDACTED }));
    }
    return out;
}

/**
 * @template {Record<string, string> | undefined} H
 * @param {H} headers
 * @returns {H}
 */
function redactHeaders(headers) {
    if (!headers) {
        return headers;
    }
    return /** @type {H} */ (
        Object.fromEntries(
            Object.entries(headers).map(([name, value]) => [
                name,
                SENSITIVE_HEADERS.has(name.toLowerCase()) ? REDACTED : value,
            ]),
        )
    );
}
