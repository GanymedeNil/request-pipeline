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

function createStorageArea(initial = {}) {
    const data = { ...initial };
    return {
        data,
        async get(key) {
            return key in data ? { [key]: data[key] } : {};
        },
        async set(items) {
            Object.assign(data, items);
        },
        async remove(key) {
            delete data[key];
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

    const chrome = {
        storage: {
            local: createStorageArea(local),
            session: createStorageArea(session),
        },
        runtime: { onMessage },
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

// Replays the events Chrome emits for one request.
export function replayRequest(fake, tabId, { requestId, url, type = 'XHR', method = 'GET', request = {}, finish = 'loadingFinished' }) {
    fake.event(tabId, 'Network.requestWillBeSent', {
        requestId,
        type,
        request: { url, method, headers: {}, ...request },
    });
    fake.event(tabId, 'Network.responseReceived', {
        requestId,
        type,
        response: { url, status: 200, headers: {} },
    });
    if (finish === 'loadingFinished') {
        fake.event(tabId, 'Network.loadingFinished', { requestId });
    } else if (finish === 'loadingFailed') {
        fake.event(tabId, 'Network.loadingFailed', { requestId, errorText: 'net::ERR_FAILED' });
    }
}
