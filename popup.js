import { DEFAULT_SERVER, SERVER_STORAGE_KEY } from './config.js';

const tabsSelect = document.getElementById('tabs');
const serverInput = document.getElementById('server');
const statusEl = document.getElementById('status');

// chrome:// pages, the Web Store and other extensions can't be attached to.
const ATTACHABLE_URL = /^(https?|file):/;

const [tabs, state, server] = await Promise.all([
    chrome.tabs.query({}),
    chrome.runtime.sendMessage({ type: 'status' }),
    loadServer(),
]);

for (const tab of tabs) {
    if (ATTACHABLE_URL.test(tab.url ?? '') || tab.id === state.tabId) {
        tabsSelect.add(new Option(tab.title || tab.url, String(tab.id)));
    }
}
serverInput.value = server;
render(state);

tabsSelect.addEventListener('change', async () => {
    await saveServer();
    const value = tabsSelect.value;
    const response = await chrome.runtime.sendMessage(
        value === '' ? { type: 'stop' } : { type: 'start', tabId: Number(value) },
    );
    render(response, response.ok ? '' : `Could not capture this tab: ${response.error}`);
});

let saveTimer;
serverInput.addEventListener('input', () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveServer, 300);
});
serverInput.addEventListener('change', saveServer);

function render(state, error = '') {
    tabsSelect.value = state.tabId == null ? '' : String(state.tabId);
    const messages = [];
    if (error) {
        messages.push(error);
    }
    if (state.lastSendError) {
        const { server, message } = state.lastSendError;
        messages.push(`Last forward to ${server} failed: ${message}`);
    }
    statusEl.textContent = messages.join('\n');
    statusEl.hidden = messages.length === 0;
}

async function loadServer() {
    const { [SERVER_STORAGE_KEY]: stored } = await chrome.storage.local.get(SERVER_STORAGE_KEY);
    if (stored !== undefined) {
        return stored;
    }
    // Versions up to 1.0.2 kept the address in the popup's localStorage, which the service worker
    // can't read. Move it over once.
    const legacy = localStorage.getItem('server');
    if (legacy !== null) {
        await chrome.storage.local.set({ [SERVER_STORAGE_KEY]: legacy });
        localStorage.removeItem('server');
        return legacy;
    }
    return DEFAULT_SERVER;
}

// The service worker reads the address from storage for every request, so a change applies
// immediately, including to a capture that's already running.
async function saveServer() {
    clearTimeout(saveTimer);
    const value = serverInput.value.trim();
    const valid = value === '' || isHttpUrl(value);
    serverInput.classList.toggle('invalid', !valid);
    serverInput.setAttribute('aria-invalid', String(!valid));
    if (valid) {
        await chrome.storage.local.set({ [SERVER_STORAGE_KEY]: value });
    }
}

function isHttpUrl(value) {
    try {
        return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
        return false;
    }
}
