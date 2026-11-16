// Service worker: attaches the debugger to the chosen tab and to the targets it spawns (cross-site
// iframes, workers), turns Network events into records and forwards them. Capture state lives in
// chrome.storage.session so it survives worker restarts.

import { CAPTURE_STATE_KEY, DEFAULT_SETTINGS, emptyCaptureState } from './config.js';
import { createFilter, createUrlMatcher } from './lib/filter.js';
import { forward } from './lib/forward.js';
import {
    buildRecord,
    limitBodies,
    sseRecord,
    webSocketCloseRecord,
    webSocketErrorRecord,
    webSocketMessageRecord,
    webSocketOpenRecord,
} from './lib/record.js';
import { redactRecord } from './lib/redact.js';

/**
 * @typedef {import('./config.js').Settings} Settings
 * @typedef {import('./config.js').CaptureState} CaptureState
 * @typedef {import('./config.js').Message} Message
 * @typedef {import('./config.js').StatusResponse} StatusResponse
 * @typedef {import('./lib/record.js').PendingRequest} PendingRequest
 * @typedef {import('./lib/record.js').StreamInfo} StreamInfo
 * @typedef {import('./lib/record.js').ForwardedRecord} ForwardedRecord
 * @typedef {chrome.debugger.DebuggerSession} Session
 * @typedef {import('devtools-protocol/types/protocol-mapping').ProtocolMapping.Commands} Commands
 * @typedef {import('devtools-protocol').Protocol.Network.RequestWillBeSentEvent} RequestWillBeSentEvent
 * @typedef {import('devtools-protocol').Protocol.Network.ResponseReceivedEvent} ResponseReceivedEvent
 * @typedef {import('devtools-protocol').Protocol.Network.LoadingFinishedEvent} LoadingFinishedEvent
 * @typedef {import('devtools-protocol').Protocol.Network.LoadingFailedEvent} LoadingFailedEvent
 * @typedef {import('devtools-protocol').Protocol.Network.EventSourceMessageReceivedEvent} EventSourceMessageEvent
 * @typedef {import('devtools-protocol').Protocol.Network.WebSocketCreatedEvent} WebSocketCreatedEvent
 * @typedef {import('devtools-protocol').Protocol.Network.WebSocketWillSendHandshakeRequestEvent} WebSocketHandshakeRequestEvent
 * @typedef {import('devtools-protocol').Protocol.Network.WebSocketHandshakeResponseReceivedEvent} WebSocketHandshakeResponseEvent
 * @typedef {import('devtools-protocol').Protocol.Network.WebSocketFrameSentEvent} WebSocketFrameEvent
 * @typedef {import('devtools-protocol').Protocol.Network.WebSocketFrameErrorEvent} WebSocketFrameErrorEvent
 * @typedef {import('devtools-protocol').Protocol.Network.WebSocketClosedEvent} WebSocketClosedEvent
 * @typedef {import('devtools-protocol').Protocol.Target.AttachedToTargetEvent} AttachedToTargetEvent
 * @typedef {import('devtools-protocol').Protocol.Target.DetachedFromTargetEvent} DetachedFromTargetEvent
 */

// https://chromedevtools.github.io/devtools-protocol/tot/Network
const PROTOCOL_VERSION = '1.0';

// Cross-site iframes and workers run as separate targets that the tab's own session doesn't see.
// Auto-attach pauses each one until Network is enabled in it, so its first requests aren't missed.
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };
/** Child target types whose network traffic is captured; others are only resumed. */
const NETWORK_TARGETS = new Set(['iframe', 'worker', 'shared_worker', 'service_worker']);

/** Shared with the popup through chrome.storage.session; only this service worker writes it. */
let capture = emptyCaptureState();
/** @type {Map<string, PendingRequest>} HTTP requests that haven't finished loading, by {@link key}. */
const pending = new Map();
/** @type {Map<string, StreamInfo>} Open WebSockets and EventSources being forwarded, by {@link key}. */
const streams = new Map();
/** @type {Map<string, string>} Child target type by session ID. */
const sessions = new Map();

/** @type {Settings} */
let settings = { ...DEFAULT_SETTINGS };
let shouldForward = createFilter(settings);
let urlMatches = createUrlMatcher(settings);

/** @param {Partial<Settings>} values */
function applySettings(values) {
    settings = { ...DEFAULT_SETTINGS, ...values };
    shouldForward = createFilter(settings);
    urlMatches = createUrlMatcher(settings);
}

/**
 * Request IDs are only unique within a target, so they're qualified by the session they came from.
 * @param {string | undefined} sessionId
 * @param {string} requestId
 */
function key(sessionId, requestId) {
    return `${sessionId ?? ''}|${requestId}`;
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
        for (const [name, { newValue }] of Object.entries(changes)) {
            if (name in DEFAULT_SETTINGS) {
                updated[name] = newValue ?? DEFAULT_SETTINGS[/** @type {keyof Settings} */ (name)];
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

// Stats change with every record, so their writes (and the badge) are batched.
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
    streams.clear();
    sessions.clear();
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
        await cdp({ tabId }, 'Network.enable', {});
    } catch (err) {
        await setCaptureTab(null);
        await chrome.debugger.detach({ tabId }).catch(() => {});
        throw err;
    }
    // Without it only the tab's own requests are seen; the capture is still useful, so carry on.
    await cdp({ tabId }, 'Target.setAutoAttach', AUTO_ATTACH).catch((err) =>
        console.warn('[request-pipeline] cannot follow iframes and workers', err),
    );
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
    // Child sessions end with it.
    await chrome.debugger.detach({ tabId }).catch(() => {});
}

/**
 * Typed wrapper around chrome.debugger.sendCommand.
 * @template {keyof Commands} M
 * @param {Session} session
 * @param {M} method
 * @param {Commands[M]['paramsType']} params The command's parameters, if it takes any.
 * @returns {Promise<Commands[M]['returnType']>}
 */
async function cdp(session, method, ...params) {
    return /** @type {Commands[M]['returnType']} */ (
        await chrome.debugger.sendCommand(session, method, /** @type {object | undefined} */ (params[0]))
    );
}

/**
 * Enables Network in a newly attached iframe or worker, follows its own children, then lets it run.
 * @param {number} tabId
 * @param {AttachedToTargetEvent} event
 */
async function attachChild(tabId, { sessionId, targetInfo, waitingForDebugger }) {
    const session = { tabId, sessionId };
    sessions.set(sessionId, targetInfo.type);
    try {
        if (NETWORK_TARGETS.has(targetInfo.type)) {
            await cdp(session, 'Network.enable', {});
            await cdp(session, 'Target.setAutoAttach', AUTO_ATTACH);
        }
    } catch (err) {
        console.warn('[request-pipeline] cannot capture', targetInfo.type, targetInfo.url, err);
    } finally {
        // The target is paused until resumed; never leave it hanging.
        if (waitingForDebugger) {
            await cdp(session, 'Runtime.runIfWaitingForDebugger').catch(() => {});
        }
    }
}

/** @param {string} sessionId */
function forgetSession(sessionId) {
    sessions.delete(sessionId);
    const prefix = key(sessionId, '');
    for (const map of [pending, streams]) {
        for (const id of map.keys()) {
            if (id.startsWith(prefix)) {
                map.delete(id);
            }
        }
    }
}

/**
 * @param {Session} source
 * @param {string} method
 * @param {object | undefined} params
 */
function handleEvent(source, method, params) {
    const { tabId, sessionId } = source;
    if (tabId === undefined || tabId !== capture.tabId) {
        return;
    }
    // A child seen before a service worker restart isn't in `sessions` any more.
    const targetType = sessionId === undefined ? 'page' : (sessions.get(sessionId) ?? 'unknown');
    /** @param {string} requestId */
    const id = (requestId) => key(sessionId, requestId);
    /**
     * A cross-site iframe's document request starts in the parent's session and finishes in the
     * iframe's own. Its ID is a loader ID, unique across targets, so a Document request is matched by
     * ID alone and moved to the session it finishes in (where its body can be read).
     * @param {string} requestId
     */
    const findPending = (requestId) => {
        const exact = pending.get(id(requestId));
        if (exact) {
            return exact;
        }
        for (const [otherKey, entry] of pending) {
            if (entry.resourceType === 'Document' && otherKey.endsWith(`|${requestId}`)) {
                pending.delete(otherKey);
                entry.sessionId = sessionId;
                entry.targetType = targetType;
                pending.set(id(requestId), entry);
                return entry;
            }
        }
        return undefined;
    };
    /**
     * @param {string} requestId
     * @param {number} [time]
     */
    const streamContext = (requestId, time) => {
        const stream = streams.get(id(requestId));
        return stream && { stream, tabId, requestId, time };
    };

    switch (method) {
        case 'Target.attachedToTarget':
            attachChild(tabId, /** @type {AttachedToTargetEvent} */ (params));
            break;
        case 'Target.detachedFromTarget':
            forgetSession(/** @type {DetachedFromTargetEvent} */ (params).sessionId);
            break;

        case 'Network.requestWillBeSent': {
            const event = /** @type {RequestWillBeSentEvent} */ (params);
            // EventSource bodies can't be read once the stream ends; its messages are forwarded instead.
            if (event.type === 'EventSource') {
                if (settings.captureEventSource && urlMatches(event.request.url)) {
                    streams.set(id(event.requestId), {
                        kind: 'sse',
                        url: event.request.url,
                        targetType,
                        documentURL: event.documentURL,
                        clockOffset: event.wallTime - event.timestamp,
                    });
                }
                break;
            }
            // A redirect reuses the requestId; the record follows the latest hop.
            if (shouldForward(event.request, event.type)) {
                pending.set(id(event.requestId), {
                    request: event.request,
                    sessionId,
                    targetType,
                    resourceType: event.type,
                    documentURL: event.documentURL,
                    wallTime: event.wallTime,
                    startTime: event.timestamp,
                });
            } else {
                pending.delete(id(event.requestId));
            }
            break;
        }
        case 'Network.responseReceived': {
            const event = /** @type {ResponseReceivedEvent} */ (params);
            const entry = findPending(event.requestId);
            if (entry) {
                entry.response = event.response;
            }
            break;
        }
        case 'Network.loadingFinished': {
            const event = /** @type {LoadingFinishedEvent} */ (params);
            streams.delete(id(event.requestId));
            const entry = findPending(event.requestId);
            if (entry) {
                pending.delete(id(event.requestId));
                entry.endTime = event.timestamp;
                finalize(tabId, event.requestId, entry).catch((err) =>
                    console.error('[request-pipeline] failed to finalize', entry.request.url, err),
                );
            }
            break;
        }
        case 'Network.loadingFailed': {
            const event = /** @type {LoadingFailedEvent} */ (params);
            pending.delete(id(event.requestId));
            streams.delete(id(event.requestId));
            break;
        }

        case 'Network.eventSourceMessageReceived': {
            const event = /** @type {EventSourceMessageEvent} */ (params);
            const context = streamContext(event.requestId, event.timestamp);
            if (context?.stream.kind === 'sse') {
                deliverInOrder(id(event.requestId), sseRecord(context, event));
            }
            break;
        }

        case 'Network.webSocketCreated': {
            const event = /** @type {WebSocketCreatedEvent} */ (params);
            if (settings.captureWebSocket && urlMatches(event.url)) {
                streams.set(id(event.requestId), { kind: 'websocket', url: event.url, targetType });
            }
            break;
        }
        case 'Network.webSocketWillSendHandshakeRequest': {
            const event = /** @type {WebSocketHandshakeRequestEvent} */ (params);
            const stream = streams.get(id(event.requestId));
            if (stream) {
                stream.clockOffset = event.wallTime - event.timestamp;
                stream.requestHeaders = event.request.headers;
            }
            break;
        }
        case 'Network.webSocketHandshakeResponseReceived': {
            const event = /** @type {WebSocketHandshakeResponseEvent} */ (params);
            const context = streamContext(event.requestId, event.timestamp);
            if (context) {
                deliverInOrder(id(event.requestId), webSocketOpenRecord(context, event.response));
            }
            break;
        }
        case 'Network.webSocketFrameSent':
        case 'Network.webSocketFrameReceived': {
            const event = /** @type {WebSocketFrameEvent} */ (params);
            const context = streamContext(event.requestId, event.timestamp);
            if (context) {
                const direction = method === 'Network.webSocketFrameSent' ? 'sent' : 'received';
                deliverInOrder(id(event.requestId), webSocketMessageRecord(context, direction, event.response));
            }
            break;
        }
        case 'Network.webSocketFrameError': {
            const event = /** @type {WebSocketFrameErrorEvent} */ (params);
            const context = streamContext(event.requestId, event.timestamp);
            if (context) {
                deliverInOrder(id(event.requestId), webSocketErrorRecord(context, event.errorMessage));
            }
            break;
        }
        case 'Network.webSocketClosed': {
            const event = /** @type {WebSocketClosedEvent} */ (params);
            const context = streamContext(event.requestId, event.timestamp);
            if (context) {
                streams.delete(id(event.requestId));
                deliverInOrder(id(event.requestId), webSocketCloseRecord(context));
            }
            break;
        }
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
    const { request, response, sessionId } = entry;
    const session = { tabId, sessionId };
    const needsPostData = request.hasPostData && request.postData === undefined;

    const [cookies, body, postData] = await Promise.allSettled([
        cdp(session, 'Network.getCookies', { urls: [response?.url ?? request.url] }),
        cdp(session, 'Network.getResponseBody', { requestId }),
        needsPostData ? cdp(session, 'Network.getRequestPostData', { requestId }) : Promise.resolve(null),
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

    await deliver(
        buildRecord({
            tabId,
            requestId,
            pending: entry,
            responseBody: body.value,
            cookies: cookies.status === 'fulfilled' ? cookies.value.cookies : undefined,
            postData: postData.status === 'fulfilled' ? postData.value?.postData : undefined,
        }),
    );
}

/** @type {Map<string, Promise<void>>} Send queue per stream, so its messages arrive in order. */
const streamQueues = new Map();

/**
 * @param {string} streamId
 * @param {ForwardedRecord} record
 */
function deliverInOrder(streamId, record) {
    const next = (streamQueues.get(streamId) ?? Promise.resolve())
        .then(() => deliver(record))
        .catch((err) => console.error('[request-pipeline] failed to deliver', record.kind, err));
    streamQueues.set(streamId, next);
    next.then(() => {
        if (streamQueues.get(streamId) === next) {
            streamQueues.delete(streamId);
        }
    });
}

/**
 * Applies the size limit and redaction, forwards the record and counts the result.
 * @param {ForwardedRecord} record
 */
async function deliver(record) {
    // Turning a stream option off stops sockets and EventSources that are already open, too.
    if (
        (record.kind === 'websocket' && !settings.captureWebSocket) ||
        (record.kind === 'sse' && !settings.captureEventSource)
    ) {
        return;
    }
    let out = limitBodies(record, settings.maxBodyKB * 1024);
    if (settings.redact) {
        out = redactRecord(out);
    }

    const { server } = settings;
    if (!server) {
        return;
    }
    const result = await forward(server, out);
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
