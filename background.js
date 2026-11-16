// Service worker: attaches the debugger to the chosen tab, turns Network events into records and
// forwards them. Capture state lives in chrome.storage.session so it survives worker restarts.

import { CAPTURE_STATE_KEY, DEFAULT_SETTINGS, emptyCaptureState } from './config.js';
import { createFilter } from './lib/filter.js';
import { forward } from './lib/forward.js';
import { buildRecord, limitBodies } from './lib/record.js';
import { redactRecord } from './lib/redact.js';

/**
 * @typedef {import('./config.js').Settings} Settings
 * @typedef {import('./config.js').CaptureState} CaptureState
 * @typedef {import('./config.js').Message} Message
 * @typedef {import('./config.js').StatusResponse} StatusResponse
 * @typedef {import('./lib/record.js').PendingRequest} PendingRequest
 * @typedef {import('devtools-protocol').Protocol.Network.RequestWillBeSentEvent} RequestWillBeSentEvent
 * @typedef {import('devtools-protocol').Protocol.Network.ResponseReceivedEvent} ResponseReceivedEvent
 * @typedef {import('devtools-protocol').Protocol.Network.LoadingFinishedEvent} LoadingFinishedEvent
 * @typedef {import('devtools-protocol').Protocol.Network.LoadingFailedEvent} LoadingFailedEvent
 * @typedef {import('devtools-protocol/types/protocol-mapping').ProtocolMapping.Commands} Commands
 */

// https://chromedevtools.github.io/devtools-protocol/tot/Network
const PROTOCOL_VERSION = '1.0';

/** Shared with the popup through chrome.storage.session; only this service worker writes it. */
let capture = emptyCaptureState();
/** @type {Map<string, PendingRequest>} Requests that haven't finished loading yet. */
const pending = new Map();

/** @type {Settings} */
let settings = { ...DEFAULT_SETTINGS };
let shouldForward = createFilter(settings);

/** @param {Partial<Settings>} values */
function applySettings(values) {
    settings = { ...DEFAULT_SETTINGS, ...values };
    shouldForward = createFilter(settings);
}

/** @type {Promise<unknown>} */
const ready = Promise.all([
    chrome.storage.session.get(CAPTURE_STATE_KEY).then((stored) => {
        capture = { ...emptyCaptureState(), .../** @type {Partial<CaptureState>} */ (stored[CAPTURE_STATE_KEY]) };
    }),
    chrome.storage.local.get(DEFAULT_SETTINGS).then((stored) => applySettings(/** @type {Settings} */ (stored))),
]);

// Start/stop/detach are serialized so quick tab switches can't interleave attach and detach.
/** @type {Promise<unknown>} */
let stateQueue = Promise.resolve();
/**
 * @param {() => Promise<void>} task
 * @returns {Promise<void>}
 */
function serialize(task) {
    const run = stateQueue.then(() => ready).then(task);
    stateQueue = run.catch(() => {});
    return run;
}

// Listeners are registered at the top level so they are back in place when Chrome restarts
// the service worker.
chrome.debugger.onEvent.addListener((source, method, params) => {
    ready
        .then(() => handleEvent(source, method, params))
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
        /** @type {Record<string, unknown>} */
        const updated = { ...settings };
        for (const [key, { newValue }] of Object.entries(changes)) {
            if (key in DEFAULT_SETTINGS) {
                updated[key] = newValue ?? DEFAULT_SETTINGS[/** @type {keyof Settings} */ (key)];
            }
        }
        applySettings(updated);
    });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    handleMessage(message).then(sendResponse, (err) =>
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err), ...status() }),
    );
    return true; // respond asynchronously
});

/**
 * @param {Message} message
 * @returns {Promise<StatusResponse>}
 */
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
            throw new Error(`Unknown message type: ${/** @type {{ type?: unknown }} */ (message)?.type}`);
    }
    return { ok: true, ...status() };
}

function status() {
    return { ...capture, pending: pending.size };
}

// Stats change with every request, so their writes (and the badge) are batched.
/** @type {ReturnType<typeof setTimeout> | null} */
let persistTimer = null;
function schedulePersist() {
    persistTimer ??= setTimeout(() => {
        persistCapture().catch((err) => console.warn('[request-pipeline] could not save state', err));
    }, 250);
}

async function persistCapture() {
    if (persistTimer !== null) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    updateBadge();
    await chrome.storage.session.set({ [CAPTURE_STATE_KEY]: capture });
}

function updateBadge() {
    const { tabId, stats, lastSendError } = capture;
    const text = tabId === null ? '' : formatCount(stats.forwarded);
    chrome.action.setBadgeText({ text }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: lastSendError ? '#d93025' : '#1a73e8' }).catch(() => {});
}

/** @param {number} n */
function formatCount(n) {
    return n < 1000 ? String(n) : `${Math.min(Math.floor(n / 1000), 999)}k`;
}

/**
 * Starting a capture resets the stats; stopping keeps them so the popup can show the totals.
 * @param {number | null} tabId
 */
async function setCaptureTab(tabId) {
    pending.clear();
    capture = tabId === null ? { ...capture, tabId: null } : { ...emptyCaptureState(), tabId };
    await persistCapture();
}

/** @param {number} tabId */
async function startCapture(tabId) {
    if (!Number.isInteger(tabId)) {
        throw new Error(`Invalid tab id: ${tabId}`);
    }
    if (tabId === capture.tabId) {
        return;
    }
    await stopCapture();

    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
    // Set before Network.enable so the first events aren't dropped by the tab check.
    await setCaptureTab(tabId);
    try {
        await cdp(tabId, 'Network.enable', {});
    } catch (err) {
        await setCaptureTab(null);
        await chrome.debugger.detach({ tabId }).catch(() => {});
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

/**
 * Typed wrapper around chrome.debugger.sendCommand.
 * @template {keyof Commands} M
 * @param {number} tabId
 * @param {M} method
 * @param {NonNullable<Commands[M]['paramsType'][0]>} params
 * @returns {Promise<Commands[M]['returnType']>}
 */
async function cdp(tabId, method, params) {
    return /** @type {Commands[M]['returnType']} */ (await chrome.debugger.sendCommand({ tabId }, method, params));
}

/**
 * @param {chrome.debugger.DebuggerSession} source
 * @param {string} method
 * @param {object | undefined} params
 */
function handleEvent(source, method, params) {
    const tabId = source.tabId;
    if (tabId === undefined || tabId !== capture.tabId) {
        return;
    }
    switch (method) {
        case 'Network.requestWillBeSent': {
            const event = /** @type {RequestWillBeSentEvent} */ (params);
            // A redirect reuses the requestId; the record follows the latest hop.
            if (shouldForward(event.request, event.type)) {
                pending.set(event.requestId, {
                    request: event.request,
                    resourceType: event.type,
                    documentURL: event.documentURL,
                    wallTime: event.wallTime,
                    startTime: event.timestamp,
                });
            } else {
                pending.delete(event.requestId);
            }
            break;
        }
        case 'Network.responseReceived': {
            const event = /** @type {ResponseReceivedEvent} */ (params);
            const entry = pending.get(event.requestId);
            if (entry) {
                entry.response = event.response;
            }
            break;
        }
        case 'Network.loadingFinished': {
            const event = /** @type {LoadingFinishedEvent} */ (params);
            const entry = pending.get(event.requestId);
            if (entry) {
                pending.delete(event.requestId);
                entry.endTime = event.timestamp;
                finalize(tabId, event.requestId, entry).catch((err) =>
                    console.error('[request-pipeline] failed to finalize', entry.request.url, err),
                );
            }
            break;
        }
        case 'Network.loadingFailed':
            pending.delete(/** @type {LoadingFailedEvent} */ (params).requestId);
            break;
    }
}

/**
 * Collects cookies, the response body and (if it was too large to be inlined) the request body, then
 * forwards one record. Everything is awaited together so no field can arrive after the send.
 * @param {number} tabId
 * @param {string} requestId
 * @param {PendingRequest} entry
 */
async function finalize(tabId, requestId, entry) {
    const { request, response } = entry;
    const needsPostData = request.hasPostData && request.postData === undefined;

    const [cookies, body, postData] = await Promise.allSettled([
        cdp(tabId, 'Network.getCookies', { urls: [response?.url ?? request.url] }),
        cdp(tabId, 'Network.getResponseBody', { requestId }),
        needsPostData ? cdp(tabId, 'Network.getRequestPostData', { requestId }) : Promise.resolve(null),
    ]);

    if (body.status === 'rejected') {
        // e.g. redirects, or the body was evicted from the DevTools buffer.
        console.warn('[request-pipeline] no response body, skipped', request.url, body.reason?.message);
        capture.stats.skipped++;
        schedulePersist();
        return;
    }
    if (postData.status === 'rejected') {
        console.warn('[request-pipeline] could not read request body', request.url, postData.reason?.message);
    }
    if (cookies.status === 'rejected') {
        console.warn('[request-pipeline] could not read cookies', request.url, cookies.reason?.message);
    }

    let record = buildRecord({
        tabId,
        requestId,
        pending: entry,
        responseBody: body.value,
        cookies: cookies.status === 'fulfilled' ? cookies.value.cookies : undefined,
        postData: postData.status === 'fulfilled' ? postData.value?.postData : undefined,
    });
    record = limitBodies(record, settings.maxBodyKB * 1024);
    if (settings.redact) {
        record = redactRecord(record);
    }

    const { server } = settings;
    if (!server) {
        return;
    }
    const result = await forward(server, record);
    if (result.ok) {
        capture.stats.forwarded++;
        capture.lastSendError = null;
    } else {
        capture.stats.failed++;
        capture.lastSendError = { server, message: result.message, at: Date.now() };
        console.warn('[request-pipeline] failed to forward to', server, result.message);
    }
    schedulePersist();
}
