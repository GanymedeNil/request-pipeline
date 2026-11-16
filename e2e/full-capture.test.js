// Captures a page whose traffic doesn't all come from the tab itself: a cross-site iframe, a
// dedicated worker, an EventSource and a WebSocket. Forwards to examples/receiver.py, so its
// WebSocket HAR output is checked too.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { launchBrowser, openPopup, startPythonReceiver, startSite, waitFor } from './harness.js';

let site, receiver, browser, popup, records;

const httpPaths = () =>
    receiver
        .records()
        .filter((r) => r.kind === 'http')
        .map((r) => [new URL(r.request.url).pathname, r.target_type]);

before(async () => {
    site = await startSite();
    receiver = await startPythonReceiver();
    browser = await launchBrowser();
    const target = await browser.context.newPage();
    await target.goto(`${site.url}full`);
    popup = await openPopup(browser);
    await popup.page.evaluate(
        (server) =>
            chrome.storage.local.set({ server, reloadOnStart: true, captureWebSocket: true, captureEventSource: true }),
        receiver.url,
    );
    const tabId = await popup.page.evaluate(async (url) => (await chrome.tabs.query({ url }))[0].id, `${site.url}full`);
    const started = await popup.page.evaluate((id) => chrome.runtime.sendMessage({ type: 'start', tabId: id }), tabId);
    assert.equal(started.ok, true, started.error);

    // Everything the page does after the reload: socket closed, both SSE messages, iframe and worker calls.
    records = await waitFor(() => {
        const all = receiver.records();
        const done =
            all.some((r) => r.kind === 'websocket' && r.event === 'close') &&
            all.filter((r) => r.kind === 'sse').length === 2 &&
            all.some((r) => r.kind === 'http' && r.request.url.endsWith('/api/in-iframe')) &&
            all.some((r) => r.kind === 'http' && r.request.url.endsWith('/api/from-worker'));
        return done && all;
    }, 15000);
    assert.ok(
        records,
        `timed out; got ${JSON.stringify(receiver.records().map((r) => [r.kind, r.event, r.request?.url]))}`,
    );
});

after(async () => {
    await browser?.close();
    site?.close();
    receiver?.close();
});

test('the cross-site iframe and its requests are captured and attributed to it', () => {
    const paths = httpPaths();
    assert.deepEqual(
        paths.filter(([p]) => p === '/frame' || p === '/api/in-iframe'),
        [
            ['/frame', 'iframe'],
            ['/api/in-iframe', 'iframe'],
        ],
    );
});

test("the dedicated worker's requests are captured and attributed to it", () => {
    assert.deepEqual(
        httpPaths().filter(([p]) => p === '/api/from-worker'),
        [['/api/from-worker', 'worker']],
    );
});

test('EventSource messages arrive as sse records and the stream makes no HTTP record', () => {
    const sse = records.filter((r) => r.kind === 'sse');
    assert.deepEqual(
        sse.map((r) => [r.event_name, r.data, new URL(r.url).pathname, r.target_type]),
        [
            ['tick', '1', '/sse', 'page'],
            ['message', 'two', '/sse', 'page'],
        ],
    );
    assert.ok(!httpPaths().some(([p]) => p === '/sse'));
});

test('the WebSocket arrives as open, four messages and close, in order', () => {
    const socket = records.filter((r) => r.kind === 'websocket');
    assert.deepEqual(
        socket.map((r) => [r.event, r.direction ?? '', r.opcode ?? '', r.data ?? '']),
        [
            ['open', '', '', ''],
            ['message', 'sent', 1, 'hello'],
            ['message', 'sent', 2, 'AQID'],
            ['message', 'received', 1, 'echo:hello'],
            ['message', 'received', 2, 'AQID'],
            ['close', '', '', ''],
        ],
    );
    const [open] = socket;
    assert.equal(open.response.status, 101);
    assert.equal(new URL(open.url).pathname, '/ws');
    assert.ok(socket.every((r) => Math.abs(r.timestamp - Date.now()) < 60000));
});

test('the receiver puts the WebSocket messages into the HAR like Chrome DevTools does', () => {
    const entry = receiver.har().log.entries.find((e) => e._resourceType === 'websocket');
    assert.ok(entry, 'websocket entry in the HAR');
    assert.equal(entry.response.status, 101);
    assert.deepEqual(
        entry._webSocketMessages.map((m) => [m.type, m.opcode, m.data]),
        [
            ['send', 1, 'hello'],
            ['send', 2, 'AQID'],
            ['receive', 1, 'echo:hello'],
            ['receive', 2, 'AQID'],
        ],
    );
});

test('no uncaught errors in the popup or the service worker', () => {
    assert.deepEqual(popup.errors, []);
    assert.deepEqual(browser.workerErrors, []);
});
