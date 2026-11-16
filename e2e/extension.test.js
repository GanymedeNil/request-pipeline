// Drives the real extension in Chrome through its popup. The tests run in order and share one
// browser: each step builds on the state the previous one left.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
    launchBrowser,
    openPopup,
    sleep,
    startNodeReceiver,
    startPythonReceiver,
    startSite,
    stopServiceWorker,
    waitFor,
} from './harness.js';

let site, pyReceiver, nodeReceiver, browser, target, popup, targetTabId;

const pathOf = (record) => {
    const url = new URL(record.request.url);
    return url.pathname + url.search;
};
const findRecord = (records, part) => waitFor(() => records().find((r) => r.request.url.includes(part)));

before(async () => {
    site = await startSite();
    pyReceiver = await startPythonReceiver();
    nodeReceiver = await startNodeReceiver();
    browser = await launchBrowser();
    target = await browser.context.newPage();
    await target.goto(site.url);
    await target.waitForFunction(() => document.title === 'done');
    popup = await openPopup(browser);
});

after(async () => {
    await browser?.close();
    site?.close();
    pyReceiver?.close();
    await nodeReceiver?.close();
});

test('an address saved by 1.0.2 in localStorage is migrated', async () => {
    await popup.page.evaluate((url) => localStorage.setItem('server', url), pyReceiver.url);
    await popup.reload();
    const migrated = await popup.page.evaluate(async () => ({
        input: document.getElementById('server').value,
        stored: (await chrome.storage.local.get('server')).server,
        legacy: localStorage.getItem('server'),
    }));
    assert.deepEqual(migrated, { input: pyReceiver.url, stored: pyReceiver.url, legacy: null });
});

test('the idle popup lists only attachable tabs and offers Start', async () => {
    await (await browser.context.newPage()).goto('chrome://version');
    await popup.reload();
    const idle = await popup.page.evaluate(() => ({
        options: [...document.querySelectorAll('#tab option')].map((o) => o.textContent),
        button: document.getElementById('toggle').textContent,
        status: document.getElementById('status').textContent,
        live: !document.getElementById('live').hidden,
        warning: !document.getElementById('server-warning').hidden,
    }));
    assert.deepEqual(idle, {
        options: ['done'],
        button: 'Start capture',
        status: 'Not capturing',
        live: false,
        warning: false,
    });
    await popup.screenshot('1-idle');
});

test('Options stays open when the popup is reopened', async () => {
    await popup.ensureOptionsOpen();
    await popup.reload();
    assert.equal(await popup.page.$eval('#options', (el) => el.open), true);
});

test('Start with "reload" captures the page load and forwards the documented record', async () => {
    await popup.page.check('[data-setting="reloadOnStart"]');
    await sleep(150);
    targetTabId = await popup.page.evaluate(
        async (url) => (await chrome.tabs.query({ url: url + '*' }))[0].id,
        site.url,
    );
    await popup.page.selectOption('#tab', String(targetTabId));
    await target.evaluate(() => (document.title = 'before reload'));
    await popup.page.click('#toggle');
    await target.waitForFunction(() => document.title === 'done', null, { timeout: 8000 });
    await findRecord(pyReceiver.records, '/api/upload');
    await sleep(500);

    const records = pyReceiver.records();
    const paths = records.map(pathOf);
    for (const expected of ['/', '/api/data?x=1', '/api/upload']) {
        assert.ok(paths.includes(expected), `${expected} in ${paths}`);
    }
    assert.ok(!paths.some((p) => p.startsWith('/app.js') || p.startsWith('/logo.png')), `no assets in ${paths}`);

    const upload = records.find((r) => r.request.url.includes('/api/upload'));
    assert.equal(upload.request.postData.length, 300000);

    const api = records.find((r) => r.request.url.includes('/api/data'));
    assert.equal(api.schema_version, 1);
    assert.equal(api.tab_id, targetTabId);
    assert.equal(api.document_url, site.url);
    assert.equal(api.resource_type, 'Fetch');
    assert.equal(typeof api.request_id, 'string');
    assert.ok(Math.abs(api.timestamp - Date.now()) < 60000, `timestamp ${api.timestamp}`);
    assert.ok(Number.isInteger(api.duration_ms) && api.duration_ms >= 0, `duration_ms ${api.duration_ms}`);
    assert.equal(api.request.headers.Authorization, 'Bearer top-secret');
    assert.ok(api.cookies.some((c) => c.name === 'sid' && c.value === 'abc123'));
    assert.equal(JSON.parse(api.response_body.body).path, '/api/data');
});

test('the popup and badge show the running capture', async () => {
    await sleep(400);
    const forwarded = pyReceiver.records().length;
    const ui = await popup.page.evaluate(() => ({
        button: document.getElementById('toggle').textContent,
        selectDisabled: document.getElementById('tab').disabled,
        live: !document.getElementById('live').hidden,
        status: document.getElementById('status').textContent,
    }));
    assert.deepEqual(ui, {
        button: 'Stop capture',
        selectDisabled: true,
        live: true,
        status: `${forwarded} forwarded · 0 failed · 0 skipped`,
    });
    assert.deepEqual(await popup.badge(), { text: String(forwarded), color: [26, 115, 232, 255] });
    await popup.screenshot('2-capturing');
});

test('redaction strips auth headers and cookie values', async () => {
    await popup.page.check('[data-setting="redact"]');
    await sleep(150);
    await target.evaluate(() => fetch('/api/data?x=redact', { headers: { Authorization: 'Bearer top-secret' } }));
    const record = await findRecord(pyReceiver.records, 'x=redact');
    assert.equal(record.request.headers.Authorization, '[REDACTED]');
    assert.ok(record.cookies.length > 0 && record.cookies.every((c) => c.value === '[REDACTED]'));
});

test('enabling a resource type forwards it', async () => {
    await popup.page.check('#types input[value="Image"]');
    await sleep(150);
    await target.evaluate(
        () =>
            new Promise((resolve) => {
                const img = new Image();
                img.onload = img.onerror = resolve;
                img.src = '/logo.png?on';
            }),
    );
    assert.ok(await findRecord(pyReceiver.records, 'logo.png?on'));
});

test('URL patterns and methods filter a running capture', async () => {
    await popup.setField('[data-setting="includeUrls"]', '*/api/*');
    await popup.setField('[data-setting="methods"]', 'GET');
    await target.evaluate(async () => {
        await fetch('/other?inc');
        await fetch('/api/data?inc=post', { method: 'POST', body: 'a' });
        await fetch('/api/data?inc=get');
    });
    await findRecord(pyReceiver.records, 'inc=get');
    await sleep(300);
    const matched = pyReceiver
        .records()
        .map(pathOf)
        .filter((p) => p.includes('inc'));
    assert.deepEqual(matched, ['/api/data?inc=get']);
    await popup.setField('[data-setting="includeUrls"]', '');
    await popup.setField('[data-setting="methods"]', '');
});

test('bodies over the size limit become a marker, and an invalid limit is not saved', async () => {
    await popup.setField('[data-setting="maxBodyKB"]', '1');
    await target.evaluate(() => fetch('/api/big'));
    const big = await findRecord(pyReceiver.records, '/api/big');
    assert.equal(big.response_body.body, null);
    assert.equal(big.response_body.omitted, 'too_large');
    assert.ok(big.response_body.length > 5000);

    await popup.setField('[data-setting="maxBodyKB"]', '-1');
    const state = await popup.page.evaluate(async () => ({
        invalid: document.querySelector('[data-setting="maxBodyKB"]').classList.contains('invalid'),
        stored: (await chrome.storage.local.get('maxBodyKB')).maxBodyKB,
    }));
    assert.deepEqual(state, { invalid: true, stored: 1 });
    await popup.setField('[data-setting="maxBodyKB"]', '0');
});

test('a remote, unencrypted server address shows a warning', async () => {
    await popup.page.uncheck('[data-setting="redact"]');
    await popup.setField('#server', 'http://collector.example.com/in');
    const warning = await popup.text('#server-warning');
    assert.match(warning, /collector\.example\.com/);
    assert.match(warning, /Redact/);
    assert.match(warning, /not encrypted/);
    await popup.screenshot('3-remote-warning');

    await popup.page.check('[data-setting="redact"]');
    await sleep(150);
    const redactedWarning = await popup.text('#server-warning');
    assert.doesNotMatch(redactedWarning, /Redact/);
    assert.match(redactedWarning, /not encrypted/);
    await popup.page.uncheck('[data-setting="redact"]');
});

test('a new server address applies to the running capture', async () => {
    await popup.setField('#server', nodeReceiver.url);
    await target.evaluate(() => fetch('/api/data?x=b'));
    assert.ok(await waitFor(() => nodeReceiver.records.find((r) => r.request.url.includes('x=b'))));
});

test('capture and counters survive a service worker restart', async () => {
    const before = await popup.status();
    await sleep(400); // let batched stats reach storage
    const { stopped, transitions } = await stopServiceWorker(browser, popup.page);
    assert.ok(stopped, `worker stopped: ${transitions}`);

    await target.evaluate(() => fetch('/api/data?x=restart'));
    assert.ok(await waitFor(() => nodeReceiver.records.find((r) => r.request.url.includes('x=restart')), 8000));
    assert.ok(transitions.lastIndexOf('running') > transitions.indexOf('stopped'), transitions.join('>'));

    const after = await popup.status();
    assert.equal(after.tabId, targetTabId);
    assert.equal(after.stats.forwarded, before.stats.forwarded + 1);
});

test('a receiver that is down shows up as failures and a red badge', async () => {
    await nodeReceiver.close();
    await target.evaluate(() => fetch('/api/data?x=down'));
    await sleep(800);
    await popup.reload();
    const error = await popup.text('#error');
    assert.match(error, /failed/);
    assert.ok(error.includes(nodeReceiver.url), error);
    assert.match(await popup.text('#status'), /· 1 failed/);
    assert.deepEqual((await popup.badge()).color, [217, 48, 37, 255]);
    await popup.screenshot('4-failure');
});

test('Stop ends the capture and keeps the totals', async () => {
    await popup.page.click('#toggle');
    await sleep(400);
    const ui = await popup.page.evaluate(() => ({
        button: document.getElementById('toggle').textContent,
        status: document.getElementById('status').textContent,
        selectDisabled: document.getElementById('tab').disabled,
    }));
    assert.equal(ui.button, 'Start capture');
    assert.match(ui.status, /^Last capture: /);
    assert.equal(ui.selectDisabled, false);
    assert.equal((await popup.badge()).text, '');
    assert.equal((await popup.status()).tabId, null);
});

test('attaching to a chrome:// page reports the error', async () => {
    const chromeTab = await popup.page.evaluate(
        async () => (await chrome.tabs.query({ url: 'chrome://version/' }))[0]?.id,
    );
    const response = await popup.page.evaluate(
        (tabId) => chrome.runtime.sendMessage({ type: 'start', tabId }),
        chromeTab,
    );
    assert.equal(response.ok, false);
    assert.ok(response.error);
});

test('closing the captured tab ends the capture', async () => {
    await popup.setField('#server', pyReceiver.url);
    await popup.page.uncheck('[data-setting="reloadOnStart"]');
    const started = await popup.page.evaluate(
        (tabId) => chrome.runtime.sendMessage({ type: 'start', tabId }),
        targetTabId,
    );
    assert.equal(started.ok, true, started.error);
    await target.close();
    assert.ok(await waitFor(() => popup.status().then((s) => s.tabId === null)));
});

test('the reference receiver wrote matching JSONL, HAR and console output', () => {
    const records = pyReceiver.records();
    const har = pyReceiver.har();
    assert.equal(har.log.version, '1.2');
    assert.equal(har.log.entries.length, records.length);

    const upload = har.log.entries.find((e) => e.request.url.includes('/api/upload'));
    assert.equal(upload.request.postData.text.length, 300000);
    const api = har.log.entries.find((e) => e.request.url.includes('/api/data?x=1'));
    assert.equal(api.response.status, 200);
    assert.equal(JSON.parse(api.response.content.text).path, '/api/data');
    assert.ok(api.request.queryString.some((q) => q.name === 'x' && q.value === '1'));
    assert.ok(api.request.headers.some((h) => h.name === 'Authorization'));
    assert.equal(typeof api.time, 'number');
    assert.ok(!Number.isNaN(Date.parse(api.startedDateTime)));

    assert.equal(pyReceiver.stdout().trim().split('\n').length, records.length);
});

test('no uncaught errors in the popup or the service worker', () => {
    assert.deepEqual(popup.errors, []);
    assert.deepEqual(browser.workerErrors, []);
});
