// The privacy policy says the site's own pages load nothing from other sites (Cloudflare, which serves
// the domain, adds its own scripts; the policy discloses those). These tests hold the pages to that, and
// check that every local link, image, font and anchor resolves in the built site.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { buildSite } from '../scripts/build-site.js';

let out;
const pages = () => fs.readdirSync(out).filter((f) => f.endsWith('.html'));
const read = (file) => fs.readFileSync(path.join(out, file), 'utf8');
const isExternal = (url) => /^(https?:)?\/\//i.test(url);
const attrs = (html, name) => [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, 'g'))].map((m) => m[1]);

before(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-site-'));
    buildSite(out);
});

after(() => fs.rmSync(out, { recursive: true, force: true }));

test('the site has a home page, a privacy policy and terms', () => {
    assert.deepEqual(pages().sort(), ['index.html', 'privacy.html', 'terms.html']);
});

test('pages load nothing from other sites', () => {
    for (const page of pages()) {
        const html = read(page);
        const loaded = [
            ...attrs(html, 'src'),
            ...[...html.matchAll(/<link\b[^>]*>/g)].flatMap((m) => attrs(m[0], 'href')),
        ];
        assert.deepEqual(loaded.filter(isExternal), [], `${page} loads external resources`);
    }
    const css = read('styles.css');
    const urls = [...css.matchAll(/url\(['"]?([^'")]+)/g)].map((m) => m[1]);
    assert.ok(urls.length > 0);
    assert.deepEqual(urls.filter(isExternal), [], 'styles.css loads external resources');
    assert.doesNotMatch(css, /@import/);
});

test('every local link, image, script, stylesheet and font exists', () => {
    const missing = [];
    for (const page of pages()) {
        const html = read(page);
        for (const ref of [...attrs(html, 'src'), ...attrs(html, 'href')]) {
            if (isExternal(ref) || ref.startsWith('#') || ref.startsWith('mailto:')) {
                continue;
            }
            const file = ref === './' ? 'index.html' : ref.split('#')[0];
            if (!fs.existsSync(path.join(out, file))) {
                missing.push(`${page} -> ${ref}`);
            }
        }
    }
    for (const [, url] of read('styles.css').matchAll(/url\(['"]?([^'")]+)/g)) {
        if (!fs.existsSync(path.join(out, url))) {
            missing.push(`styles.css -> ${url}`);
        }
    }
    assert.deepEqual(missing, []);
});

test('in-page anchors point at elements that exist', () => {
    for (const page of pages()) {
        const html = read(page);
        const ids = new Set(attrs(html, 'id'));
        const anchors = attrs(html, 'href').filter((h) => h.startsWith('#'));
        assert.deepEqual(
            anchors.filter((a) => !ids.has(a.slice(1))),
            [],
            `${page} has anchors without targets`,
        );
    }
});

test('the font licenses ship with the fonts', () => {
    const fonts = fs.readdirSync(path.join(out, 'fonts'));
    for (const family of ['unbounded', 'ibm-plex-sans', 'ibm-plex-mono']) {
        assert.ok(fonts.includes(`LICENSE-${family}.txt`), `license for ${family}`);
        assert.ok(
            fonts.some((f) => f.startsWith(`${family}-`) && f.endsWith('.woff2')),
            `font files for ${family}`,
        );
    }
});

test('every image has alt text', () => {
    for (const page of pages()) {
        for (const [tag] of read(page).matchAll(/<img\b[^>]*>/g)) {
            assert.match(tag, /\salt="/, `${page}: ${tag}`);
        }
    }
});
