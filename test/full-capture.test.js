// Child targets (cross-site iframes, workers), WebSocket and EventSource capture.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createFakeChrome, loadBackground, replayRequest, replayWebSocket, settle } from './fake-chrome.js';

let sent;
let fetchImpl;

beforeEach(() => {
    sent = [];
    fetchImpl = async () => ({ ok: true, status: 200 });
    globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        const result = await fetchImpl(body);
        sent.push(body);
        return result;
    };
});

async function startedOn(tabId, options) {
    const fake = createFakeChrome(options);
    await loadBackground(fake);
    const response = await fake.message({ type: 'start', tabId });
    assert.equal(response.ok, true, response.error);
    return fake;
}

const commandsIn = (fake, sessionId) => fake.commands.filter((c) => c.sessionId === sessionId).map((c) => c.method);
const status = (fake) => fake.message({ type: 'status' });

// --- child targets ---

test('starting a capture asks Chrome to pause and report new iframes and workers', async () => {
    const fake = await startedOn(1);
    const autoAttach = fake.commands.find((c) => c.method === 'Target.setAutoAttach' && c.sessionId === undefined);
    assert.deepEqual(autoAttach.params, { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
});

test('a new child gets Network and auto-attach, and is resumed last', async () => {
    const fake = await startedOn(1);
    fake.attachChild(1, 'S1', 'iframe');
    await settle();
    assert.deepEqual(commandsIn(fake, 'S1'), [
        'Network.enable',
        'Target.setAutoAttach',
        'Runtime.runIfWaitingForDebugger',
    ]);
});

test('a child is resumed even when enabling Network in it fails', async () => {
    const fake = await startedOn(1);
    fake.handlers['Network.enable'] = (target) => {
        if (target.sessionId) {
            throw new Error('Not allowed');
        }
        return {};
    };
    fake.attachChild(1, 'S1', 'worker');
    await settle();
    assert.deepEqual(commandsIn(fake, 'S1'), ['Network.enable', 'Runtime.runIfWaitingForDebugger']);
});

test('other target types are only resumed, and running ones are left alone', async () => {
    const fake = await startedOn(1);
    fake.attachChild(1, 'W1', 'auction_worklet');
    fake.attachChild(1, 'S2', 'iframe', { waitingForDebugger: false });
    await settle();
    assert.deepEqual(commandsIn(fake, 'W1'), ['Runtime.runIfWaitingForDebugger']);
    assert.deepEqual(commandsIn(fake, 'S2'), ['Network.enable', 'Target.setAutoAttach']);
});

test("a child's requests carry its target type and are read from its session, even with clashing IDs", async () => {
    const fake = await startedOn(1);
    fake.attachChild(1, 'S1', 'iframe');
    fake.attachChild(1, 'S2', 'worker', { parentSessionId: 'S1' });
    await settle();
    // All three start before any finishes, so a key without the session would mix them up.
    const requests = [
        { requestId: 'r1', url: 'https://page.test/api' },
        { requestId: 'r1', url: 'https://embed.test/api', sessionId: 'S1' },
        { requestId: 'r1', url: 'https://embed.test/from-worker', sessionId: 'S2' },
    ];
    for (const r of requests) {
        replayRequest(fake, 1, { ...r, finish: 'none' });
    }
    for (const { requestId, sessionId } of requests) {
        fake.event(1, 'Network.loadingFinished', { requestId, timestamp: 101 }, sessionId);
    }
    await settle();

    const byUrl = Object.fromEntries(sent.map((r) => [r.request.url, r.target_type]));
    assert.deepEqual(byUrl, {
        'https://page.test/api': 'page',
        'https://embed.test/api': 'iframe',
        'https://embed.test/from-worker': 'worker',
    });
    const bodyReads = fake.commands.filter((c) => c.method === 'Network.getResponseBody').map((c) => c.sessionId);
    assert.deepEqual(bodyReads.sort(), ['S1', 'S2', undefined].sort());
});

test("a cross-site iframe's document, announced by the parent and finished in the iframe, is one record", async () => {
    const fake = await startedOn(1);
    // Chrome reports the navigation request to the parent before the iframe's target exists.
    fake.event(1, 'Network.requestWillBeSent', {
        requestId: 'LOADER-1',
        type: 'Document',
        documentURL: 'https://embed.test/frame',
        timestamp: 100,
        wallTime: 1700000100,
        request: { url: 'https://embed.test/frame', method: 'GET', headers: {} },
    });
    fake.attachChild(1, 'S1', 'iframe');
    await settle();
    fake.event(
        1,
        'Network.responseReceived',
        {
            requestId: 'LOADER-1',
            type: 'Document',
            response: { url: 'https://embed.test/frame', status: 200, headers: {} },
        },
        'S1',
    );
    fake.event(1, 'Network.loadingFinished', { requestId: 'LOADER-1', timestamp: 100.5 }, 'S1');
    await settle();

    assert.equal(sent.length, 1);
    assert.equal(sent[0].request.url, 'https://embed.test/frame');
    assert.equal(sent[0].target_type, 'iframe');
    assert.equal(sent[0].response.status, 200);
    assert.equal(sent[0].duration_ms, 500);
    const bodyRead = fake.commands.find((c) => c.method === 'Network.getResponseBody');
    assert.equal(bodyRead.sessionId, 'S1');
});

test("a detached child's unfinished requests are dropped", async () => {
    const fake = await startedOn(1);
    fake.attachChild(1, 'S1', 'iframe');
    await settle();
    replayRequest(fake, 1, { requestId: 'r1', url: 'https://embed.test/slow', sessionId: 'S1', finish: 'none' });
    await settle();
    assert.equal((await status(fake)).pending, 1);

    fake.event(1, 'Target.detachedFromTarget', { sessionId: 'S1' });
    await settle();
    assert.equal((await status(fake)).pending, 0);
});

// --- WebSocket ---

const SOCKET = 'wss://ws.test/chat?room=1';

test('WebSocket traffic is not forwarded unless turned on', async () => {
    const fake = await startedOn(1);
    replayWebSocket(fake, 1, { requestId: 'w1', url: SOCKET, frames: [['sent', 1, 'hi']] });
    await settle();
    assert.equal(sent.length, 0);
});

test('a WebSocket is forwarded as open, message, error and close records, in order', async () => {
    const fake = await startedOn(1, { local: { captureWebSocket: true } });
    replayWebSocket(fake, 1, {
        requestId: 'w1',
        url: SOCKET,
        frames: [
            ['sent', 1, 'hello'],
            ['received', 2, 'AAEC'],
        ],
        close: false,
    });
    fake.event(1, 'Network.webSocketFrameError', { requestId: 'w1', timestamp: 205, errorMessage: 'bad frame' });
    fake.event(1, 'Network.webSocketClosed', { requestId: 'w1', timestamp: 210 });
    await settle();

    assert.deepEqual(
        sent.map((r) => [r.kind, r.event, r.direction ?? '']),
        [
            ['websocket', 'open', ''],
            ['websocket', 'message', 'sent'],
            ['websocket', 'message', 'received'],
            ['websocket', 'error', ''],
            ['websocket', 'close', ''],
        ],
    );
    const [open, text, binary, error, close] = sent;
    assert.deepEqual(
        { ...open, timestamp: undefined },
        {
            schema_version: 1,
            kind: 'websocket',
            event: 'open',
            request_id: 'w1',
            tab_id: 1,
            target_type: 'page',
            url: SOCKET,
            timestamp: undefined,
            request: { headers: { Cookie: 'sid=abc', 'Sec-WebSocket-Version': '13' } },
            response: { status: 101, statusText: 'Switching Protocols', headers: { Upgrade: 'websocket' } },
        },
    );
    assert.equal(open.timestamp, 1700000200010);
    assert.deepEqual([text.opcode, text.data, text.base64Encoded, text.timestamp], [1, 'hello', false, 1700000201000]);
    assert.deepEqual([binary.opcode, binary.data, binary.base64Encoded], [2, 'AAEC', true]);
    assert.equal(error.error_message, 'bad frame');
    assert.equal(close.timestamp, 1700000210000);
});

test('messages of one socket stay in order even when an earlier send is slower', async () => {
    const fake = await startedOn(1, { local: { captureWebSocket: true } });
    fetchImpl = async (record) => {
        if (record.event === 'open') {
            await new Promise((resolve) => setTimeout(resolve, 30));
        }
        return { ok: true, status: 200 };
    };
    replayWebSocket(fake, 1, {
        requestId: 'w1',
        url: SOCKET,
        frames: [
            ['sent', 1, 'a'],
            ['sent', 1, 'b'],
        ],
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(
        sent.map((r) => r.data ?? r.event),
        ['open', 'a', 'b', 'close'],
    );
});

test('sockets opened before capture started, or outside the URL patterns, are ignored', async () => {
    const fake = await startedOn(1, { local: { captureWebSocket: true, excludeUrls: 'telemetry' } });
    replayWebSocket(fake, 1, { requestId: 'early', url: SOCKET, created: false, frames: [['received', 1, 'x']] });
    replayWebSocket(fake, 1, { requestId: 'tel', url: 'wss://telemetry.test/', frames: [['sent', 1, 'y']] });
    await settle();
    assert.equal(sent.length, 0);
});

test('WebSocket records get the size limit and redaction, which spares payloads', async () => {
    const fake = await startedOn(1, { local: { captureWebSocket: true, maxBodyKB: 1, redact: true } });
    replayWebSocket(fake, 1, {
        requestId: 'w1',
        url: SOCKET,
        frames: [
            ['received', 1, 'z'.repeat(2000)],
            ['sent', 1, 'token=secret'],
        ],
    });
    await settle();
    const [open, big, small] = sent;
    assert.equal(open.request.headers.Cookie, '[REDACTED]');
    assert.equal(open.request.headers['Sec-WebSocket-Version'], '13');
    assert.deepEqual([big.data, big.omitted, big.length], [null, 'too_large', 2000]);
    assert.equal(small.data, 'token=secret');
});

test('turning WebSocket capture off stops sockets that are already open', async () => {
    const fake = await startedOn(1, { local: { captureWebSocket: true } });
    replayWebSocket(fake, 1, { requestId: 'w1', url: SOCKET, close: false });
    await settle();
    await fake.chrome.storage.local.set({ captureWebSocket: false });
    fake.event(1, 'Network.webSocketFrameReceived', {
        requestId: 'w1',
        timestamp: 300,
        response: { opcode: 1, mask: false, payloadData: 'late' },
    });
    await settle();
    assert.deepEqual(
        sent.map((r) => r.event),
        ['open'],
    );
});

test('a socket in a child target is attributed to it', async () => {
    const fake = await startedOn(1, { local: { captureWebSocket: true } });
    fake.attachChild(1, 'S1', 'worker');
    await settle();
    replayWebSocket(fake, 1, { requestId: 'w1', url: SOCKET, sessionId: 'S1', frames: [['received', 1, 'x']] });
    await settle();
    assert.deepEqual(new Set(sent.map((r) => r.target_type)), new Set(['worker']));
});

// --- EventSource ---

function replayEventSource(fake, tabId, { requestId, url, messages, sessionId }) {
    fake.event(
        tabId,
        'Network.requestWillBeSent',
        {
            requestId,
            type: 'EventSource',
            documentURL: 'https://page.test/',
            timestamp: 300,
            wallTime: 1700000300,
            request: { url, method: 'GET', headers: {} },
        },
        sessionId,
    );
    messages.forEach(([eventName, data], i) => {
        fake.event(
            tabId,
            'Network.eventSourceMessageReceived',
            { requestId, timestamp: 301 + i, eventName, eventId: String(i), data },
            sessionId,
        );
    });
    fake.event(tabId, 'Network.loadingFinished', { requestId, timestamp: 310 }, sessionId);
}

test('EventSource streams produce no HTTP record and nothing at all unless turned on', async () => {
    const fake = await startedOn(1);
    replayEventSource(fake, 1, { requestId: 'e1', url: 'https://a.test/events', messages: [['tick', '1']] });
    await settle();
    assert.equal(sent.length, 0);
    assert.equal((await status(fake)).stats.skipped, 0);
});

test('EventSource messages are forwarded as sse records', async () => {
    const fake = await startedOn(1, { local: { captureEventSource: true } });
    replayEventSource(fake, 1, {
        requestId: 'e1',
        url: 'https://a.test/events',
        messages: [
            ['tick', '1'],
            ['message', '{"n":2}'],
        ],
    });
    await settle();
    assert.deepEqual(sent, [
        {
            schema_version: 1,
            kind: 'sse',
            event: 'message',
            request_id: 'e1',
            tab_id: 1,
            target_type: 'page',
            url: 'https://a.test/events',
            document_url: 'https://page.test/',
            timestamp: 1700000301000,
            event_name: 'tick',
            event_id: '0',
            data: '1',
        },
        {
            schema_version: 1,
            kind: 'sse',
            event: 'message',
            request_id: 'e1',
            tab_id: 1,
            target_type: 'page',
            url: 'https://a.test/events',
            document_url: 'https://page.test/',
            timestamp: 1700000302000,
            event_name: 'message',
            event_id: '1',
            data: '{"n":2}',
        },
    ]);
});
