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
    const handlers = {
        'Network.enable': () => ({}),
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
                commands.push({ tabId: target.tabId, method, params });
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
        event(tabId, method, params) {
            onEvent.emit({ tabId }, method, params);
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
    },
) {
    fake.event(tabId, 'Network.requestWillBeSent', {
        requestId,
        type,
        documentURL,
        timestamp: startTime,
        wallTime: 1700000000 + startTime,
        request: { url, method, headers: {}, ...request },
    });
    fake.event(tabId, 'Network.responseReceived', {
        requestId,
        type,
        timestamp: startTime + duration / 2,
        response: { url, status: 200, headers: {}, ...response },
    });
    if (finish === 'loadingFinished') {
        fake.event(tabId, 'Network.loadingFinished', { requestId, timestamp: startTime + duration });
    } else if (finish === 'loadingFailed') {
        fake.event(tabId, 'Network.loadingFailed', {
            requestId,
            timestamp: startTime + duration,
            errorText: 'net::ERR_FAILED',
        });
    }
}
