import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createFakeChrome, replayRequest, settle } from './fake-chrome.js';

let instance = 0;
let sent;
let fetchImpl;

beforeEach(() => {
    sent = [];
    fetchImpl = async () => ({ ok: true, status: 200 });
    globalThis.fetch = async (url, init) => {
        sent.push({ url, body: JSON.parse(init.body) });
        return fetchImpl(url, init);
    };
});

// Each call evaluates background.js afresh, like a service worker (re)start.
async function loadBackground(fake) {
    globalThis.chrome = fake.chrome;
    const module = await import(`../background.js?instance=${++instance}`);
    await settle();
    return module;
}

async function startedOn(tabId, options) {
    const fake = createFakeChrome(options);
    await loadBackground(fake);
    const response = await fake.message({ type: 'start', tabId });
    assert.equal(response.ok, true, response.error);
    return fake;
}

const status = (fake) => fake.message({ type: 'status' });
// State and badge writes are batched (250 ms).
const persisted = () => new Promise((resolve) => setTimeout(resolve, 300));
const sentUrls = () => sent.map((s) => s.body.request.url);

test('forwards one record per finished request, with metadata', async () => {
    const fake = await startedOn(1);
    replayRequest(fake, 1, { requestId: 'r1', url: 'https://api.example.com/users', startTime: 100, duration: 0.25 });
    await settle();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, 'http://127.0.0.1:6789');
    const body = sent[0].body;
    assert.deepEqual(Object.keys(body), [
        'schema_version',
        'request_id',
        'tab_id',
        'document_url',
        'resource_type',
        'timestamp',
        'duration_ms',
        'request',
        'response',
        'cookies',
        'response_body',
    ]);
    assert.equal(body.schema_version, 1);
    assert.equal(body.request_id, 'r1');
    assert.equal(body.tab_id, 1);
    assert.equal(body.document_url, 'https://page.test/');
    assert.equal(body.resource_type, 'XHR');
    assert.equal(body.timestamp, 1700000100000);
    assert.equal(body.duration_ms, 250);
    assert.equal(body.request.url, 'https://api.example.com/users');
    assert.equal(body.response.status, 200);
    assert.deepEqual(body.cookies, [{ name: 'sid', value: 'abc' }]);
    assert.deepEqual(body.response_body, { body: 'body-r1', base64Encoded: false });
});

test('a server address changed during capture applies to the next request', async () => {
    const fake = await startedOn(1, { local: { server: 'http://old.test/' } });
    replayRequest(fake, 1, { requestId: 'r1', url: 'https://a.test/1' });
    await settle();
    await fake.chrome.storage.local.set({ server: 'http://new.test/' });
    replayRequest(fake, 1, { requestId: 'r2', url: 'https://a.test/2' });
    await settle();

    assert.deepEqual(
        sent.map((s) => s.url),
        ['http://old.test/', 'http://new.test/'],
    );
});

test('an empty server address turns forwarding off', async () => {
    const fake = await startedOn(1, { local: { server: '' } });
    replayRequest(fake, 1, { requestId: 'r1', url: 'https://a.test/1' });
    await settle();

    assert.equal(sent.length, 0);
});

test('capture keeps working after the service worker restarts', async () => {
    // State a previous service worker instance left behind; the debugger session outlives it.
    const fake = createFakeChrome({
        local: { server: 'http://saved.test/' },
        session: { capture: { tabId: 5, stats: { forwarded: 3, failed: 0, skipped: 0 }, lastSendError: null } },
    });
    fake.attached.add(5);
    await loadBackground(fake);

    replayRequest(fake, 5, { requestId: 'r1', url: 'https://a.test/1' });
    await settle();

    assert.deepEqual(
        sent.map((s) => s.url),
        ['http://saved.test/'],
    );
    const state = await status(fake);
    assert.equal(state.tabId, 5);
    assert.equal(state.stats.forwarded, 4);
});

test('cookies are included even when getCookies answers after the body', async () => {
    const fake = await startedOn(1);
    fake.handlers['Network.getCookies'] = () =>
        new Promise((resolve) => setTimeout(() => resolve({ cookies: [{ name: 'late', value: '1' }] }), 20));
    replayRequest(fake, 1, { requestId: 'r1', url: 'https://a.test/1' });
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].body.cookies, [{ name: 'late', value: '1' }]);
});

test('failed requests and requests without a body do not stay pending', async () => {
    const fake = await startedOn(1);
    replayRequest(fake, 1, { requestId: 'failed', url: 'https://a.test/1', finish: 'loadingFailed' });
    fake.handlers['Network.getResponseBody'] = () => {
        throw new Error('No resource with given identifier found');
    };
    replayRequest(fake, 1, { requestId: 'nobody', url: 'https://a.test/2' });
    await settle();

    assert.equal(sent.length, 0);
    const state = await status(fake);
    assert.equal(state.pending, 0);
    assert.equal(state.stats.skipped, 1);
});

test('static assets are filtered by resource type by default, not by URL suffix', async () => {
    const fake = await startedOn(1);
    replayRequest(fake, 1, { requestId: 'script', url: 'https://a.test/app.js?v=3', type: 'Script' });
    replayRequest(fake, 1, { requestId: 'css', url: 'https://a.test/site.css', type: 'Stylesheet' });
    replayRequest(fake, 1, { requestId: 'img', url: 'https://a.test/logo.png', type: 'Image' });
    replayRequest(fake, 1, { requestId: 'data', url: 'data:text/plain,hi', type: 'Fetch' });
    replayRequest(fake, 1, { requestId: 'api', url: 'https://a.test/api/getjs', type: 'XHR' });
    replayRequest(fake, 1, { requestId: 'doc', url: 'https://a.test/', type: 'Document' });
    await settle();

    assert.deepEqual(sentUrls(), ['https://a.test/api/getjs', 'https://a.test/']);
});

test('resource types changed in the popup apply during a capture', async () => {
    const fake = await startedOn(1);
    replayRequest(fake, 1, { requestId: 'img1', url: 'https://a.test/1.png', type: 'Image' });
    await settle();
    await fake.chrome.storage.local.set({ ignoredTypes: ['XHR'] });
    replayRequest(fake, 1, { requestId: 'img2', url: 'https://a.test/2.png', type: 'Image' });
    replayRequest(fake, 1, { requestId: 'xhr', url: 'https://a.test/api', type: 'XHR' });
    await settle();

    assert.deepEqual(sentUrls(), ['https://a.test/2.png']);
});

test('URL include/exclude patterns and methods filter requests', async () => {
    const fake = await startedOn(1, {
        local: { includeUrls: '*://api.test/*\n# comment\n/graphql', excludeUrls: 'health', methods: 'get, post' },
    });
    const cases = [
        ['in-get', 'https://api.test/users', 'GET'],
        ['in-post', 'https://api.test/users', 'POST'],
        ['in-delete', 'https://api.test/users/1', 'DELETE'],
        ['in-excluded', 'https://api.test/healthz', 'GET'],
        ['substring', 'https://other.test/v1/graphql?op=Q', 'POST'],
        ['outside', 'https://cdn.test/api.test/x', 'GET'],
    ];
    for (const [requestId, url, method] of cases) {
        replayRequest(fake, 1, { requestId, url, method });
    }
    await settle();

    assert.deepEqual(
        sent.map((s) => s.body.request_id),
        ['in-get', 'in-post', 'substring'],
    );
});

test('request bodies CDP did not inline are fetched', async () => {
    const fake = await startedOn(1);
    replayRequest(fake, 1, {
        requestId: 'big',
        url: 'https://a.test/upload',
        method: 'POST',
        request: { hasPostData: true },
    });
    replayRequest(fake, 1, {
        requestId: 'small',
        url: 'https://a.test/form',
        method: 'POST',
        request: { hasPostData: true, postData: 'a=1' },
    });
    await settle();

    const bodies = Object.fromEntries(sent.map((s) => [s.body.request.url, s.body.request.postData]));
    assert.deepEqual(bodies, { 'https://a.test/upload': 'post-big', 'https://a.test/form': 'a=1' });
    const postDataCalls = fake.commands.filter((c) => c.method === 'Network.getRequestPostData');
    assert.deepEqual(
        postDataCalls.map((c) => c.params.requestId),
        ['big'],
    );
});

test('bodies over the size limit are replaced by a marker', async () => {
    const fake = await startedOn(1, { local: { maxBodyKB: 1 } });
    fake.handlers['Network.getResponseBody'] = (target, { requestId }) => ({
        body: requestId === 'large' ? 'x'.repeat(1025) : 'small',
        base64Encoded: false,
    });
    replayRequest(fake, 1, {
        requestId: 'large',
        url: 'https://a.test/big',
        method: 'POST',
        request: { hasPostData: true, postData: 'y'.repeat(2000) },
    });
    replayRequest(fake, 1, { requestId: 'fits', url: 'https://a.test/small' });
    await settle();

    const [large, fits] = sent.map((s) => s.body);
    assert.deepEqual(large.response_body, { body: null, base64Encoded: false, omitted: 'too_large', length: 1025 });
    assert.equal(large.request.postData, null);
    assert.equal(large.request.postDataOmitted, 'too_large');
    assert.equal(large.request.postDataLength, 2000);
    assert.deepEqual(fits.response_body, { body: 'small', base64Encoded: false });
});

test('credentials are redacted only when the setting is on', async () => {
    const fake = await startedOn(1);
    const request = { headers: { Authorization: 'Bearer secret', Accept: 'application/json' } };
    const response = {
        headers: { 'set-cookie': 'sid=abc', 'content-type': 'application/json' },
        headersText: 'set-cookie: sid=abc',
    };
    replayRequest(fake, 1, { requestId: 'plain', url: 'https://a.test/1', request, response });
    await settle();
    await fake.chrome.storage.local.set({ redact: true });
    replayRequest(fake, 1, { requestId: 'redacted', url: 'https://a.test/2', request, response });
    await settle();

    const [plain, redacted] = sent.map((s) => s.body);
    assert.equal(plain.request.headers.Authorization, 'Bearer secret');
    assert.equal(plain.cookies[0].value, 'abc');
    assert.deepEqual(redacted.request.headers, { Authorization: '[REDACTED]', Accept: 'application/json' });
    assert.deepEqual(redacted.response.headers, { 'set-cookie': '[REDACTED]', 'content-type': 'application/json' });
    assert.equal(redacted.response.headersText, undefined);
    assert.deepEqual(redacted.cookies, [{ name: 'sid', value: '[REDACTED]' }]);
});

test('forwarding failures are counted and reported, and cleared by the next success', async () => {
    const fake = await startedOn(1);
    fetchImpl = async () => {
        throw new TypeError('Failed to fetch');
    };
    replayRequest(fake, 1, { requestId: 'r1', url: 'https://a.test/1' });
    await settle();

    const failed = await status(fake);
    assert.equal(failed.lastSendError.message, 'Failed to fetch');
    assert.equal(failed.lastSendError.server, 'http://127.0.0.1:6789');

    fetchImpl = async () => ({ ok: false, status: 500 });
    replayRequest(fake, 1, { requestId: 'r2', url: 'https://a.test/2' });
    await settle();
    assert.equal((await status(fake)).lastSendError.message, 'HTTP 500');

    fetchImpl = async () => ({ ok: true, status: 200 });
    replayRequest(fake, 1, { requestId: 'r3', url: 'https://a.test/3' });
    await settle();
    const recovered = await status(fake);
    assert.equal(recovered.lastSendError, null);
    assert.deepEqual(recovered.stats, { forwarded: 1, failed: 2, skipped: 0 });
});

test('stats reach session storage and the badge, and reset on the next start', async () => {
    const fake = await startedOn(1);
    replayRequest(fake, 1, { requestId: 'r1', url: 'https://a.test/1' });
    replayRequest(fake, 1, { requestId: 'r2', url: 'https://a.test/2' });
    await persisted();

    assert.equal(fake.badge.text, '2');
    assert.equal(fake.chrome.storage.session.data.capture.stats.forwarded, 2);

    await fake.message({ type: 'stop' });
    assert.equal(fake.badge.text, '');
    // Kept after stopping so the popup can show the totals.
    assert.deepEqual(fake.chrome.storage.session.data.capture, {
        tabId: null,
        stats: { forwarded: 2, failed: 0, skipped: 0 },
        lastSendError: null,
    });

    await fake.message({ type: 'start', tabId: 2 });
    assert.equal(fake.badge.text, '0');
    assert.equal(fake.chrome.storage.session.data.capture.stats.forwarded, 0);
});

test('the tab is reloaded after Network.enable when reloadOnStart is on', async () => {
    const off = await startedOn(1);
    assert.deepEqual(off.reloads, []);

    const on = await startedOn(1, { local: { reloadOnStart: true } });
    assert.equal(on.reloads.length, 1);
    const [reload] = on.reloads;
    assert.equal(reload.tabId, 1);
    assert.equal(reload.attached, true);
    assert.deepEqual(
        on.commands.slice(0, reload.commands).map((c) => c.method),
        ['Network.enable'],
    );
});

test('attach failures are returned to the popup', async () => {
    const fake = createFakeChrome();
    fake.attachErrors.set(9, 'Cannot access a chrome:// URL');
    await loadBackground(fake);

    const response = await fake.message({ type: 'start', tabId: 9 });
    assert.equal(response.ok, false);
    assert.equal(response.error, 'Cannot access a chrome:// URL');
    assert.equal(response.tabId, null);
});

test('a session the user cancelled is cleaned up and the next start works', async () => {
    const fake = await startedOn(1);
    fake.externalDetach(1);
    await settle();
    assert.equal((await status(fake)).tabId, null);

    const response = await fake.message({ type: 'start', tabId: 2 });
    assert.equal(response.ok, true, response.error);
    assert.deepEqual([...fake.attached], [2]);
});

test('switching tabs detaches the previous one and ignores its late events', async () => {
    const fake = await startedOn(1);
    replayRequest(fake, 1, { requestId: 'early', url: 'https://one.test/', finish: 'none' });
    const response = await fake.message({ type: 'start', tabId: 2 });
    assert.equal(response.ok, true, response.error);
    assert.deepEqual([...fake.attached], [2]);

    fake.event(1, 'Network.loadingFinished', { requestId: 'early' });
    replayRequest(fake, 2, { requestId: 'r1', url: 'https://two.test/' });
    await settle();

    assert.deepEqual(sentUrls(), ['https://two.test/']);
});

test('quick successive starts end with only the last tab attached', async () => {
    const fake = createFakeChrome();
    await loadBackground(fake);
    const responses = await Promise.all([1, 2, 3].map((tabId) => fake.message({ type: 'start', tabId })));

    assert.ok(
        responses.every((r) => r.ok),
        JSON.stringify(responses),
    );
    assert.deepEqual([...fake.attached], [3]);
    assert.equal((await status(fake)).tabId, 3);
});

test('stop detaches and clears the capture', async () => {
    const fake = await startedOn(1);
    const response = await fake.message({ type: 'stop' });

    assert.equal(response.ok, true);
    assert.equal(response.tabId, null);
    assert.equal(fake.attached.size, 0);
    assert.equal(fake.chrome.storage.session.data.capture.tabId, null);
});
