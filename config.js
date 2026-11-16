// Settings, state shapes and message types shared by the service worker (background.js) and the popup.

export const DEFAULT_SERVER = 'http://127.0.0.1:6789';

/**
 * @typedef {object} Settings
 * @property {string} server Where records are POSTed. An empty string turns forwarding off.
 * @property {string[]} ignoredTypes CDP resource types that are not forwarded.
 *   https://chromedevtools.github.io/devtools-protocol/tot/Network/#type-ResourceType
 * @property {string} includeUrls URL patterns, one per line. `*` matches anything; a pattern without `*`
 *   matches any URL containing it. An empty list lets every URL through.
 * @property {string} excludeUrls Same syntax; exclude wins over include.
 * @property {string} methods HTTP methods to forward, separated by commas or spaces. Empty means all.
 * @property {number} maxBodyKB Request and response bodies longer than this many KB (as forwarded, so
 *   base64 for binary) are replaced by a marker. 0 means no limit.
 * @property {boolean} redact Replace credentials (auth and cookie headers, cookie values) with "[REDACTED]".
 * @property {boolean} reloadOnStart Reload the tab right after capture starts, so page-load requests are included.
 * @property {boolean} captureWebSocket Forward WebSocket opens, messages, errors and closes as `kind: "websocket"` records.
 * @property {boolean} captureEventSource Forward EventSource (SSE) messages as `kind: "sse"` records.
 */

/**
 * Every setting with its default. Each one is its own key in chrome.storage.local, so
 * `chrome.storage.local.get(DEFAULT_SETTINGS)` returns the stored values merged over the defaults.
 * @type {Readonly<Settings>}
 */
export const DEFAULT_SETTINGS = Object.freeze({
    server: DEFAULT_SERVER,
    ignoredTypes: ['Stylesheet', 'Script', 'Image', 'Media', 'Font', 'TextTrack', 'Manifest', 'Preflight'],
    includeUrls: '',
    excludeUrls: '',
    methods: '',
    maxBodyKB: 0,
    redact: false,
    reloadOnStart: false,
    captureWebSocket: false,
    captureEventSource: false,
});

/** Resource types the popup offers as checkboxes. The others keep their default. */
export const TOGGLEABLE_TYPES = ['Document', 'XHR', 'Fetch', 'Script', 'Stylesheet', 'Image', 'Font', 'Media', 'Other'];

/**
 * @typedef {object} CaptureStats
 * @property {number} forwarded Records the server accepted.
 * @property {number} failed Records that could not be sent, or that the server rejected.
 * @property {number} skipped Requests whose response body Chrome could not return.
 */

/**
 * @typedef {object} SendError
 * @property {string} server
 * @property {string} message
 * @property {number} at Milliseconds since the epoch.
 */

/**
 * @typedef {object} CaptureState
 * @property {number | null} tabId The tab being captured, or null.
 * @property {CaptureStats} stats Counts for the current capture, or the last one after stopping.
 * @property {SendError | null} lastSendError Cleared by the next successful send.
 */

/** chrome.storage.session key holding the {@link CaptureState}; only the service worker writes it. */
export const CAPTURE_STATE_KEY = 'capture';

/** @returns {CaptureState} */
export function emptyCaptureState() {
    return { tabId: null, stats: { forwarded: 0, failed: 0, skipped: 0 }, lastSendError: null };
}

/**
 * Messages the popup sends to the service worker.
 * @typedef {{ type: 'start', tabId: number } | { type: 'stop' } | { type: 'status' }} Message
 */

/**
 * The service worker's answer to every {@link Message}.
 * @typedef {CaptureState & { ok: boolean, error?: string, pending: number }} StatusResponse
 */
