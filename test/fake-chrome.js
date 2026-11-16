// A minimal in-memory stand-in for the chrome.* APIs used by background.js, so CDP event
// sequences can be replayed against the real service worker code under `node --test`.

function createEvent() {
    const listeners = [];
    return {
        listeners,
        addListener: (fn) => listeners.push(fn),
        emit: (...args) => listeners.map((fn) => fn(...args)),
    };
}

function createStorageArea(area, initial, onChanged) {
    const data = structuredClone(initial);
    return {
        data,
        // Accepts a key, or an object of defaults like chrome.storage does.
        async get(keys) {
            if (typeof keys === 'string') {
                return keys in data ? { [keys]: structuredClone(data[keys]) } : {};
            }
            return Object.fromEntries(
                Object.entries(keys).map(([key, fallback]) => [
                    key,
                    structuredClone(key in data ? data[key] : fallback),
                ]),
            );
        },
        async set(items) {
            const changes = {};
            for (const [key, value] of Object.entries(items)) {
                changes[key] = { oldValue: data[key], newValue: structuredClone(value) };
                data[key] = structuredClone(value);
            }
            onChanged.emit(changes, area);
        },
        async remove(key) {
            const changes = { [key]: { oldValue: data[key] } };
            delete data[key];
            onChanged.emit(changes, area);
        },
    };
}

export function createFakeChrome({ local = {}, session = {} } = {}) {
    const attached = new Set();
    const commands = [];
    // method -> (target, params) => result | Promise<result>; throw to simulate a CDP error.
    // `target` is the debugger session: { tabId, sessionId? }.
    const handlers = {
        'Network.enable': () => ({}),
        'Target.setAutoAttach': () => ({}),
        'Runtime.runIfWaitingForDebugger': () => ({}),
        'Network.getCookies': () => ({ cookies: [{ name: 'sid', value: 'abc' }] }),
        'Network.getResponseBody': (target, { requestId }) => ({ body: `body-${requestId}`, base64Encoded: false }),
        'Network.getRequestPostData': (target, { requestId }) => ({ postData: `post-${requestId}` }),
    };
    const attachErrors = new Map(); // tabId -> message

    const onEvent = createEvent();
    const onDetach = createEvent();
    const onMessage = createEvent();
    const onStorageChanged = createEvent();
    const reloads = [];
    const badge = { text: '', color: null };

    const chrome = {
        storage: {
            local: createStorageArea('local', local, onStorageChanged),
            session: createStorageArea('session', session, onStorageChanged),
            onChanged: onStorageChanged,
        },
        runtime: { onMessage },
        tabs: {
            async reload(tabId) {
                reloads.push({ tabId, attached: attached.has(tabId), commands: commands.length });
            },
        },
        action: {
            async setBadgeText({ text }) {
                badge.text = text;
            },
            async setBadgeBackgroundColor({ color }) {
                badge.color = color;
            },
        },
        debugger: {
            onEvent,
            onDetach,
            async attach({ tabId }) {
                if (attachErrors.has(tabId)) {
                    throw new Error(attachErrors.get(tabId));
                }
                if (attached.has(tabId)) {
                    throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
                }
                attached.add(tabId);
            },
            async detach({ tabId }) {
                if (!attached.delete(tabId)) {
                    throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
                }
            },
            async sendCommand(target, method, params = {}) {
                commands.push({ tabId: target.tabId, sessionId: target.sessionId, method, params });
                if (!attached.has(target.tabId)) {
                    throw new Error(`Debugger is not attached to the tab with id: ${target.tabId}.`);
                }
                const handler = handlers[method];
                if (!handler) {
                    throw new Error(`Unexpected command ${method}`);
                }
                return handler(target, params);
            },
        },
    };

    return {
        chrome,
        attached,
        commands,
        handlers,
        attachErrors,
        reloads,
        badge,
        // Send a message as the popup would and resolve with the service worker's response.
        message(msg) {
            return new Promise((resolve) => onMessage.emit(msg, {}, resolve));
        },
        // An event from the tab, or from one of its child targets when `sessionId` is given.
        event(tabId, method, params, sessionId) {
            onEvent.emit(sessionId === undefined ? { tabId } : { tabId, sessionId }, method, params);
        },
        // Chrome auto-attaching a new iframe or worker of the tab.
        attachChild(tabId, sessionId, type = 'iframe', { waitingForDebugger = true, parentSessionId } = {}) {
            onEvent.emit(
                parentSessionId === undefined ? { tabId } : { tabId, sessionId: parentSessionId },
                'Target.attachedToTarget',
                { sessionId, targetInfo: { targetId: `target-${sessionId}`, type, url: '' }, waitingForDebugger },
            );
        },
        // What Chrome does when the user clicks Cancel on the banner or closes the tab.
        externalDetach(tabId, reason = 'canceled_by_user') {
            attached.delete(tabId);
            onDetach.emit({ tabId }, reason);
        },
    };
}

// Lets queued promise chains and timers run.
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let instance = 0;
// Evaluates background.js afresh against `fake`, like a service worker (re)start.
export async function loadBackground(fake) {
    globalThis.chrome = fake.chrome;
    const module = await import(`../background.js?instance=${++instance}`);
    await settle();
    return module;
}

// Replays the events Chrome emits for one request. `startTime` is in seconds, like CDP timestamps.
export function replayRequest(
    fake,
    tabId,
    {
        requestId,
        url,
        type = 'XHR',
        method = 'GET',
        request = {},
        response = {},
        finish = 'loadingFinished',
        startTime = 100,
        duration = 0.25,
        documentURL = 'https://page.test/',
        sessionId,
    },
) {
    fake.event(
        tabId,
        'Network.requestWillBeSent',
        {
            requestId,
            type,
            documentURL,
            timestamp: startTime,
            wallTime: 1700000000 + startTime,
            request: { url, method, headers: {}, ...request },
        },
        sessionId,
    );
    fake.event(
        tabId,
        'Network.responseReceived',
        {
            requestId,
            type,
            timestamp: startTime + duration / 2,
            response: { url, status: 200, headers: {}, ...response },
        },
        sessionId,
    );
    if (finish === 'loadingFinished') {
        fake.event(tabId, 'Network.loadingFinished', { requestId, timestamp: startTime + duration }, sessionId);
    } else if (finish === 'loadingFailed') {
        fake.event(
            tabId,
            'Network.loadingFailed',
            { requestId, timestamp: startTime + duration, errorText: 'net::ERR_FAILED' },
            sessionId,
        );
    }
}

/**
 * Replays a WebSocket's life: creation, handshake, then `frames` as [direction, opcode, payload],
 * and a close unless `close` is false. CDP times are seconds; wall clock = time + 1700000000.
 */
export function replayWebSocket(
    fake,
    tabId,
    { requestId, url, frames = [], close = true, sessionId, created = true, startTime = 200 },
) {
    const event = (method, params) => fake.event(tabId, method, { requestId, ...params }, sessionId);
    if (created) {
        event('Network.webSocketCreated', { url });
    }
    event('Network.webSocketWillSendHandshakeRequest', {
        timestamp: startTime,
        wallTime: 1700000000 + startTime,
        request: { headers: { Cookie: 'sid=abc', 'Sec-WebSocket-Version': '13' } },
    });
    event('Network.webSocketHandshakeResponseReceived', {
        timestamp: startTime + 0.01,
        response: { status: 101, statusText: 'Switching Protocols', headers: { Upgrade: 'websocket' } },
    });
    frames.forEach(([direction, opcode, payloadData], i) => {
        event(direction === 'sent' ? 'Network.webSocketFrameSent' : 'Network.webSocketFrameReceived', {
            timestamp: startTime + 1 + i,
            response: { opcode, mask: direction === 'sent', payloadData },
        });
    });
    if (close) {
        event('Network.webSocketClosed', { timestamp: startTime + 10 });
    }
}
