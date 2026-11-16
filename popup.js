import { CAPTURE_STATE_KEY, DEFAULT_SETTINGS, TOGGLEABLE_TYPES } from './config.js';

const $ = (id) => document.getElementById(id);
const tabSelect = $('tab');
const toggleButton = $('toggle');
const statusEl = $('status');
const errorEl = $('error');
const liveEl = $('live');
const serverWarningEl = $('server-warning');
const typesEl = $('types');

// chrome:// pages, the Web Store and other extensions can't be attached to.
const ATTACHABLE_URL = /^(https?|file):/;
const INVALID = Symbol('invalid');
const EMPTY_CAPTURE = { tabId: null, stats: { forwarded: 0, failed: 0, skipped: 0 }, lastSendError: null };

const [tabs, [activeTab], storedCapture, settings] = await Promise.all([
    chrome.tabs.query({}),
    chrome.tabs.query({ active: true, currentWindow: true }),
    chrome.storage.session.get(CAPTURE_STATE_KEY),
    loadSettings(),
]);
let capture = storedCapture[CAPTURE_STATE_KEY] ?? EMPTY_CAPTURE;
let actionError = '';

for (const tab of tabs) {
    if (ATTACHABLE_URL.test(tab.url ?? '') || tab.id === capture.tabId) {
        tabSelect.add(new Option(tab.title || tab.url, String(tab.id)));
    }
}
if (capture.tabId === null && activeTab && tabSelect.querySelector(`option[value="${activeTab.id}"]`)) {
    tabSelect.value = String(activeTab.id);
}
if (tabSelect.options.length === 0) {
    tabSelect.add(new Option('No tab can be captured', ''));
}

// Remember whether Options was left open.
const optionsEl = $('options');
optionsEl.open = localStorage.getItem('optionsOpen') === '1';
optionsEl.addEventListener('toggle', () => localStorage.setItem('optionsOpen', optionsEl.open ? '1' : '0'));

bindSettings();
renderTypes();
renderServerWarning();
render();

// The service worker keeps the capture state in session storage; follow it live.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && CAPTURE_STATE_KEY in changes) {
        capture = changes[CAPTURE_STATE_KEY].newValue ?? EMPTY_CAPTURE;
        render();
    }
});

toggleButton.addEventListener('click', async () => {
    toggleButton.disabled = true;
    await flushSaves();
    const response = await chrome.runtime.sendMessage(
        capture.tabId === null ? { type: 'start', tabId: Number(tabSelect.value) } : { type: 'stop' },
    );
    actionError = response.ok ? '' : `Could not capture this tab: ${response.error}`;
    capture = { tabId: response.tabId, stats: response.stats, lastSendError: response.lastSendError };
    render();
});

function render() {
    const capturing = capture.tabId !== null;
    if (capturing) {
        tabSelect.value = String(capture.tabId);
    }
    tabSelect.disabled = capturing;
    liveEl.hidden = !capturing;
    toggleButton.textContent = capturing ? 'Stop capture' : 'Start capture';
    toggleButton.classList.toggle('stop', capturing);
    toggleButton.disabled = !capturing && !tabSelect.value;

    const { forwarded, failed, skipped } = capture.stats;
    const counts = `${forwarded} forwarded · ${failed} failed · ${skipped} skipped`;
    if (capturing) {
        statusEl.textContent = settings.server ? counts : 'Forwarding is off: no server address';
    } else if (forwarded + failed + skipped > 0) {
        statusEl.textContent = `Last capture: ${counts}`;
    } else {
        statusEl.textContent = 'Not capturing';
    }

    const errors = [];
    if (actionError) {
        errors.push(actionError);
    }
    if (capture.lastSendError) {
        const { server, message } = capture.lastSendError;
        errors.push(`Last forward to ${server} failed: ${message}`);
    }
    errorEl.textContent = errors.join('\n');
    errorEl.hidden = errors.length === 0;
}

async function loadSettings() {
    // Versions up to 1.0.2 kept the server address in the popup's localStorage, which the service
    // worker can't read. Move it over once.
    const { server } = await chrome.storage.local.get('server');
    const legacy = localStorage.getItem('server');
    if (server === undefined && legacy !== null) {
        await chrome.storage.local.set({ server: legacy });
        localStorage.removeItem('server');
    }
    return chrome.storage.local.get(DEFAULT_SETTINGS);
}

// Text fields save 300 ms after typing stops (and on blur); checkboxes save on change. The service
// worker picks changes up from storage, so they apply to a capture that's already running.
const saveTimers = new Map();

function bindSettings() {
    for (const el of document.querySelectorAll('[data-setting]')) {
        const key = el.dataset.setting;
        if (el.type === 'checkbox') {
            el.checked = settings[key];
            el.addEventListener('change', () => saveField(el));
        } else {
            el.value = settings[key];
            el.addEventListener('input', () => {
                clearTimeout(saveTimers.get(el));
                saveTimers.set(el, setTimeout(() => saveField(el), 300));
            });
            el.addEventListener('change', () => saveField(el));
        }
    }
}

async function saveField(el) {
    clearTimeout(saveTimers.get(el));
    saveTimers.delete(el);
    const key = el.dataset.setting;
    const value = el.type === 'checkbox' ? el.checked : parseSetting(key, el.value);
    const valid = value !== INVALID;
    el.classList.toggle('invalid', !valid);
    el.setAttribute('aria-invalid', String(!valid));
    if (!valid || value === settings[key]) {
        return;
    }
    settings[key] = value;
    await chrome.storage.local.set({ [key]: value });
    if (key === 'server' || key === 'redact') {
        renderServerWarning();
        render();
    }
}

function flushSaves() {
    return Promise.all([...saveTimers.keys()].map(saveField));
}

function parseSetting(key, raw) {
    switch (key) {
        case 'server': {
            const value = raw.trim();
            return value === '' || isHttpUrl(value) ? value : INVALID;
        }
        case 'maxBodyKB': {
            const value = Number(raw);
            return raw.trim() !== '' && Number.isInteger(value) && value >= 0 ? value : INVALID;
        }
        default:
            return raw;
    }
}

function renderTypes() {
    for (const type of TOGGLEABLE_TYPES) {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = type;
        box.checked = !settings.ignoredTypes.includes(type);
        box.addEventListener('change', saveTypes);
        const label = document.createElement('label');
        label.append(box, type);
        typesEl.append(label);
    }
}

async function saveTypes() {
    const unchecked = [...typesEl.querySelectorAll('input:not(:checked)')].map((box) => box.value);
    // Types without a checkbox keep whatever they were set to.
    settings.ignoredTypes = [...settings.ignoredTypes.filter((t) => !TOGGLEABLE_TYPES.includes(t)), ...unchecked];
    await chrome.storage.local.set({ ignoredTypes: settings.ignoredTypes });
}

function renderServerWarning() {
    const notes = [];
    let url = null;
    try {
        url = new URL(settings.server);
    } catch {
        // empty or invalid: nothing is sent
    }
    if (url && !isLocalHost(url.hostname)) {
        notes.push(settings.redact
            ? `Records are sent to ${url.host}.`
            : `Records are sent to ${url.host}, including cookies and auth headers. Turn on "Redact credentials" under Options to strip them.`);
        if (url.protocol === 'http:') {
            notes.push('The connection is not encrypted.');
        }
    }
    serverWarningEl.textContent = notes.join(' ');
    serverWarningEl.hidden = notes.length === 0;
}

function isLocalHost(hostname) {
    return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]' || /^127\./.test(hostname);
}

function isHttpUrl(value) {
    try {
        return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
        return false;
    }
}
