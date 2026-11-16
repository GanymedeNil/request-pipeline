import { DEFAULT_SERVER, SERVER_STORAGE_KEY } from './config.js';

// https://chromedevtools.github.io/devtools-protocol/tot/Network
const PROTOCOL_VERSION = '1.0';

// Static assets are not forwarded. Filtering on the CDP resource type (instead of the URL suffix)
// also catches `app.js?v=3` and keeps `/api/getjs`.
// https://chromedevtools.github.io/devtools-protocol/tot/Network/#type-ResourceType
const IGNORED_RESOURCE_TYPES = new Set([
    'Stylesheet', 'Script', 'Image', 'Media', 'Font', 'TextTrack', 'Manifest', 'Preflight',
]);

// chrome.storage.session key: survives service worker restarts, cleared with the browser session.
const CAPTURE_TAB_KEY = 'captureTabId';

// The tab being captured. Mirrored to chrome.storage.session; only this service worker writes it.
let captureTabId = null;
// requestId -> { request, response } for requests that haven't finished loading yet.
const pending = new Map();
// Last failure forwarding a record, shown in the popup. Cleared by the next successful send.
let lastSendError = null;

const ready = chrome.storage.session.get(CAPTURE_TAB_KEY).then((stored) => {
    captureTabId = stored[CAPTURE_TAB_KEY] ?? null;
});

// Start/stop/detach are serialized so quick tab switches can't interleave attach and detach.
let stateQueue = Promise.resolve();
function serialize(task) {
    const run = stateQueue.then(() => ready).then(task);
    stateQueue = run.catch(() => {});
    return run;
}

// Listeners are registered at the top level so they are back in place when Chrome restarts
// the service worker.
chrome.debugger.onEvent.addListener((source, method, params) => {
    ready.then(() => handleEvent(source, method, params))
        .catch((err) => console.error('[request-pipeline] event handling failed', method, err));
});

chrome.debugger.onDetach.addListener((source) => {
    serialize(async () => {
        if (source.tabId === captureTabId) {
            await setCaptureTab(null);
        }
    });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message).then(
        sendResponse,
        (err) => sendResponse({ ok: false, error: err?.message ?? String(err), ...status() }),
    );
    return true; // respond asynchronously
});

async function handleMessage(message) {
    switch (message?.type) {
        case 'start':
            await serialize(() => startCapture(message.tabId));
            break;
        case 'stop':
            await serialize(stopCapture);
            break;
        case 'status':
            await ready;
            break;
        default:
            throw new Error(`Unknown message type: ${message?.type}`);
    }
    return { ok: true, ...status() };
}

function status() {
    return { tabId: captureTabId, pending: pending.size, lastSendError };
}

async function setCaptureTab(tabId) {
    captureTabId = tabId;
    pending.clear();
    if (tabId === null) {
        await chrome.storage.session.remove(CAPTURE_TAB_KEY);
    } else {
        await chrome.storage.session.set({ [CAPTURE_TAB_KEY]: tabId });
    }
}

async function startCapture(tabId) {
    if (!Number.isInteger(tabId)) {
        throw new Error(`Invalid tab id: ${tabId}`);
    }
    if (tabId === captureTabId) {
        return;
    }
    await stopCapture();

    const target = { tabId };
    await chrome.debugger.attach(target, PROTOCOL_VERSION);
    // Set before Network.enable so the first events aren't dropped by the tab check.
    await setCaptureTab(tabId);
    lastSendError = null;
    try {
        await chrome.debugger.sendCommand(target, 'Network.enable');
    } catch (err) {
        await setCaptureTab(null);
        await chrome.debugger.detach(target).catch(() => {});
        throw err;
    }
}

async function stopCapture() {
    const tabId = captureTabId;
    if (tabId === null) {
        return;
    }
    await setCaptureTab(null);
    // Throws if the session is already gone (tab closed, or the user clicked Cancel on the banner).
    await chrome.debugger.detach({ tabId }).catch(() => {});
}

function handleEvent(source, method, params) {
    if (source.tabId !== captureTabId) {
        return;
    }
    switch (method) {
        case 'Network.requestWillBeSent':
            // A redirect reuses the requestId; the record follows the latest hop.
            if (shouldCapture(params.request.url, params.type)) {
                pending.set(params.requestId, { request: params.request });
            } else {
                pending.delete(params.requestId);
            }
            break;
        case 'Network.responseReceived': {
            const record = pending.get(params.requestId);
            if (record) {
                record.response = params.response;
            }
            break;
        }
        case 'Network.loadingFinished': {
            const record = pending.get(params.requestId);
            if (record) {
                pending.delete(params.requestId);
                finalize(source.tabId, params.requestId, record)
                    .catch((err) => console.error('[request-pipeline] failed to finalize', record.request.url, err));
            }
            break;
        }
        case 'Network.loadingFailed':
            pending.delete(params.requestId);
            break;
    }
}

function shouldCapture(url, resourceType) {
    return /^https?:/.test(url) && !IGNORED_RESOURCE_TYPES.has(resourceType);
}

// Collects cookies, response body and (if it was too large to be inlined) the request body, then
// forwards one record. Everything is awaited together so no field can arrive after the send.
async function finalize(tabId, requestId, record) {
    const target = { tabId };
    const { request, response } = record;
    const needsPostData = request.hasPostData && request.postData === undefined;

    const [cookies, body, postData] = await Promise.allSettled([
        chrome.debugger.sendCommand(target, 'Network.getCookies', { urls: [response?.url ?? request.url] }),
        chrome.debugger.sendCommand(target, 'Network.getResponseBody', { requestId }),
        needsPostData
            ? chrome.debugger.sendCommand(target, 'Network.getRequestPostData', { requestId })
            : Promise.resolve(null),
    ]);

    if (body.status === 'rejected') {
        // e.g. redirects, or the body was evicted from the DevTools buffer.
        console.warn('[request-pipeline] no response body, skipped', request.url, body.reason?.message);
        return;
    }

    const data = { request, response };
    if (postData.status === 'fulfilled' && postData.value) {
        data.request = { ...request, postData: postData.value.postData };
    } else if (postData.status === 'rejected') {
        console.warn('[request-pipeline] could not read request body', request.url, postData.reason?.message);
    }
    if (cookies.status === 'fulfilled') {
        data.cookies = cookies.value.cookies;
    } else {
        console.warn('[request-pipeline] could not read cookies', request.url, cookies.reason?.message);
    }
    data.response_body = body.value;

    await send(data);
}

async function send(data) {
    const { [SERVER_STORAGE_KEY]: server = DEFAULT_SERVER } = await chrome.storage.local.get(SERVER_STORAGE_KEY);
    if (!server) {
        return;
    }
    try {
        const res = await fetch(server, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        lastSendError = null;
    } catch (err) {
        lastSendError = { server, message: err?.message ?? String(err), at: Date.now() };
        console.warn('[request-pipeline] failed to forward to', server, err);
    }
}
