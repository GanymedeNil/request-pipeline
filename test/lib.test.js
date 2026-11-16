import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '../config.js';
import { compilePatterns, createFilter, parseMethods } from '../lib/filter.js';
import { REDACTED, redactRecord } from '../lib/redact.js';

const matches = (patterns, url) => compilePatterns(patterns).some((re) => re.test(url));

test('a pattern without * matches URLs containing it, case-insensitively', () => {
    assert.ok(matches('/api/', 'https://a.test/api/users'));
    assert.ok(matches('API.TEST', 'https://api.test/'));
    assert.ok(!matches('/api/', 'https://a.test/apis'));
});

test('a pattern with * must match the whole URL', () => {
    assert.ok(matches('https://*.example.com/*', 'https://api.example.com/v1'));
    assert.ok(!matches('https://*.example.com/*', 'http://api.example.com/v1'));
    assert.ok(matches('*/v?/*', 'https://a.test/v?/x'), '? is literal, not a wildcard');
    assert.ok(!matches('*/v?/*', 'https://a.test/v1/x'));
    assert.ok(matches('*(group)*', 'https://a.test/(group)'), 'regex characters are literal');
});

test('blank lines and # comments are ignored', () => {
    assert.deepEqual(compilePatterns('\n  \n# note\n'), []);
});

test('methods are split on commas and spaces and upper-cased', () => {
    assert.deepEqual([...parseMethods(' get,post  patch ')], ['GET', 'POST', 'PATCH']);
    assert.equal(parseMethods('').size, 0);
});

test('the default filter forwards http(s) requests that are not static assets', () => {
    const forward = createFilter(DEFAULT_SETTINGS);
    assert.ok(forward({ url: 'https://a.test/api', method: 'GET' }, 'XHR'));
    assert.ok(forward({ url: 'HTTP://a.test/', method: 'GET' }, 'Document'));
    assert.ok(forward({ url: 'https://a.test/x', method: 'GET' }, undefined), 'a missing type is forwarded');
    assert.ok(!forward({ url: 'https://a.test/a.css', method: 'GET' }, 'Stylesheet'));
    assert.ok(!forward({ url: 'blob:https://a.test/1', method: 'GET' }, 'Fetch'));
    assert.ok(!forward({ url: 'chrome-extension://x/y', method: 'GET' }, 'Fetch'));
});

test('redaction covers request, response and extra-info headers plus cookie values, without mutating', () => {
    const record = {
        request: { url: 'https://a.test/', headers: { authorization: 'Bearer t', 'X-Api-Key': 'k', Accept: '*/*' } },
        response: {
            headers: { 'Set-Cookie': 'a=1', 'Content-Type': 'text/html' },
            requestHeaders: { Cookie: 'a=1', 'Proxy-Authorization': 'Basic x' },
            headersText: 'HTTP/1.1 200 OK\r\nSet-Cookie: a=1',
            requestHeadersText: 'GET / HTTP/1.1\r\nCookie: a=1',
        },
        cookies: [{ name: 'a', value: '1', httpOnly: true }],
        response_body: { body: 'unchanged', base64Encoded: false },
    };
    const before = structuredClone(record);
    const out = redactRecord(record);

    assert.deepEqual(record, before);
    assert.deepEqual(out.request.headers, { authorization: REDACTED, 'X-Api-Key': REDACTED, Accept: '*/*' });
    assert.deepEqual(out.response.headers, { 'Set-Cookie': REDACTED, 'Content-Type': 'text/html' });
    assert.deepEqual(out.response.requestHeaders, { Cookie: REDACTED, 'Proxy-Authorization': REDACTED });
    assert.ok(!('headersText' in out.response) && !('requestHeadersText' in out.response));
    assert.deepEqual(out.cookies, [{ name: 'a', value: REDACTED, httpOnly: true }]);
    assert.deepEqual(out.response_body, record.response_body);
});

test('redaction copes with a record that has no response or cookies', () => {
    const out = redactRecord({ request: { url: 'https://a.test/', headers: {} } });
    assert.deepEqual(out, { request: { url: 'https://a.test/', headers: {} } });
});
