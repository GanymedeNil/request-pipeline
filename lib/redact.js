// Removes credentials from a record before it leaves the browser. Covers headers and cookies;
// URLs and bodies are forwarded as they are.

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

export function redactRecord(record) {
    const out = { ...record, request: { ...record.request, headers: redactHeaders(record.request.headers) } };
    if (record.response) {
        out.response = {
            ...record.response,
            headers: redactHeaders(record.response.headers),
            requestHeaders: redactHeaders(record.response.requestHeaders),
        };
        // Raw header blocks would carry the same values unredacted.
        delete out.response.headersText;
        delete out.response.requestHeadersText;
    }
    if (record.cookies) {
        out.cookies = record.cookies.map((cookie) => ({ ...cookie, value: REDACTED }));
    }
    return out;
}

function redactHeaders(headers) {
    if (!headers) {
        return headers;
    }
    return Object.fromEntries(Object.entries(headers).map(
        ([name, value]) => [name, SENSITIVE_HEADERS.has(name.toLowerCase()) ? REDACTED : value],
    ));
}
