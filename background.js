import { CAPTURE_STATE_KEY, DEFAULT_SETTINGS } from './config.js';
import { createFilter } from './lib/filter.js';
import { redactRecord } from './lib/redact.js';

// https://chromedevtools.github.io/devtools-protocol/tot/Network
const PROTOCOL_VERSION = '1.0';

// Version of the forwarded record format. Records sent by 1.0.x and 1.1.x have no schema_version.
const SCHEMA_VERSION = 1;

const emptyCaptureState = () => ({
    tabId: null,
    stats: { forwarded: 0, failed: 0, skipped: 0 },
    lastSendError: null,
});

// Shared with the popup through chrome.storage.session; only this service worker writes it.
// Kept in session storage so it survives service worker restarts but not a browser restart.
let capture = emptyCaptureState();
// requestId -> { meta, request, response, endTime } for requests that haven't finished loading yet.
const pending = new Map();

let settings = { ...DEFAULT_SETTINGS };
let shouldForward = createFilter(settings);

function applySettings(values) {
    settings = { ...DEFAULT_SETTINGS, ...values };
    shouldForward = createFilter(settings);
}

const ready = Promise.all([
    chrome.storage.session.get(CAPTURE_STATE_KEY).then((stored) => {
        capture = { ...emptyCaptureState(), ...stored[CAPTURE_STATE_KEY] };
    }),
    chrome.storage.local.get(DEFAULT_SETTINGS).then(applySettings),
]);

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
        if (source.tabId === capture.tabId) {
            await setCaptureTab(null);
        }
    });
});

// Settings changed in the popup apply to the next request, including during a capture.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') {
        return;
    }
    ready.then(() => {
        const updated = { ...settings };
        for (const [key, { newValue }] of Object.entries(changes)) {
            if (key in DEFAULT_SETTINGS) {
                updated[key] = newValue ?? DEFAULT_SETTINGS[key];
            }
        }
        applySettings(updated);
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
    return { ...capture, pending: pending.size };
}

// Stats change with every request, so their writes (and the badge) are batched.
let persistTimer = null;
function schedulePersist() {
    persistTimer ??= setTimeout(() => {
        persistCapture().catch((err) => console.warn('[request-pipeline] could not save state', err));
    }, 250);
}

async function persistCapture() {
    clearTimeout(persistTimer);
    persistTimer = null;
    updateBadge();
    await chrome.storage.session.set({ [CAPTURE_STATE_KEY]: capture });
}

function updateBadge() {
    const { tabId, stats, lastSendError } = capture;
    const text = tabId === null ? '' : formatCount(stats.forwarded);
    chrome.action.setBadgeText({ text }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: lastSendError ? '#d93025' : '#1a73e8' }).catch(() => {});
}

function formatCount(n) {
    return n < 1000 ? String(n) : `${Math.min(Math.floor(n / 1000), 999)}k`;
}

// Starting a capture resets the stats; stopping keeps them so the popup can show the totals.
async function setCaptureTab(tabId) {
    pending.clear();
    capture = tabId === null ? { ...capture, tabId: null } : { ...emptyCaptureState(), tabId };
    await persistCapture();
}

async function startCapture(tabId) {
    if (!Number.isInteger(tabId)) {
        throw new Error(`Invalid tab id: ${tabId}`);
    }
    if (tabId === capture.tabId) {
        return;
    }
    await stopCapture();

    const target = { tabId };
    await chrome.debugger.attach(target, PROTOCOL_VERSION);
    // Set before Network.enable so the first events aren't dropped by the tab check.
    await setCaptureTab(tabId);
    try {
        await chrome.debugger.sendCommand(target, 'Network.enable');
    } catch (err) {
        await setCaptureTab(null);
        await chrome.debugger.detach(target).catch(() => {});
        throw err;
    }
    if (settings.reloadOnStart) {
        // Capture is already running; a failed reload only means the page-load requests are missed.
        await chrome.tabs.reload(tabId).catch((err) => console.warn('[request-pipeline] reload failed', err));
    }
}

async function stopCapture() {
    const tabId = capture.tabId;
    if (tabId === null) {
        return;
    }
    await setCaptureTab(null);
    // Throws if the session is already gone (tab closed, or the user clicked Cancel on the banner).
    await chrome.debugger.detach({ tabId }).catch(() => {});
}

function handleEvent(source, method, params) {
    if (source.tabId !== capture.tabId) {
        return;
    }
    switch (method) {
        case 'Network.requestWillBeSent':
            // A redirect reuses the requestId; the record follows the latest hop.
            if (shouldForward(params.request, params.type)) {
                pending.set(params.requestId, {
                    meta: {
                        type: params.type,
                        documentURL: params.documentURL,
                        wallTime: params.wallTime,
                        startTime: params.timestamp,
                    },
                    request: params.request,
                });
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
                record.endTime = params.timestamp;
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

// Collects cookies, response body and (if it was too large to be inlined) the request body, then
// forwards one record. Everything is awaited together so no field can arrive after the send.
async function finalize(tabId, requestId, record) {
    const target = { tabId };
    const { meta, request, response, endTime } = record;
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
        capture.stats.skipped++;
        schedulePersist();
        return;
    }

    let data = {
        schema_version: SCHEMA_VERSION,
        request_id: requestId,
        tab_id: tabId,
        document_url: meta.documentURL,
        resource_type: meta.type,
        // Milliseconds since the epoch when the request was sent.
        timestamp: meta.wallTime === undefined ? undefined : Math.round(meta.wallTime * 1000),
        duration_ms: meta.startTime === undefined || endTime === undefined
            ? undefined
            : Math.round((endTime - meta.startTime) * 1000),
        request,
        response,
    };
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

    data = limitBodies(data, settings.maxBodyKB * 1024);
    if (settings.redact) {
        data = redactRecord(data);
    }
    await send(data);
}

// Bodies over the limit are replaced by a marker that keeps their length.
function limitBodies(data, limit) {
    if (!(limit > 0)) {
        return data;
    }
    const out = { ...data };
    const postData = data.request.postData;
    if (typeof postData === 'string' && postData.length > limit) {
        out.request = { ...data.request, postData: null, postDataOmitted: 'too_large', postDataLength: postData.length };
    }
    const body = data.response_body?.body;
    if (typeof body === 'string' && body.length > limit) {
        out.response_body = { ...data.response_body, body: null, omitted: 'too_large', length: body.length };
    }
    return out;
}

async function send(data) {
    const { server } = settings;
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
        capture.stats.forwarded++;
        capture.lastSendError = null;
    } catch (err) {
        capture.stats.failed++;
        capture.lastSendError = { server, message: err?.message ?? String(err), at: Date.now() };
        console.warn('[request-pipeline] failed to forward to', server, err);
    }
    schedulePersist();
}
