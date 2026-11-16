// Builds the GitHub Pages site into dist/site: the pages in site/, the fonts they use (self-hosted, so
// the site makes no third-party requests), and the images it shows.
//
// Usage: node scripts/build-site.js [--out <dir>]

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');

const FONTS = [
    ['unbounded', 'unbounded-latin-600-normal.woff2'],
    ['ibm-plex-sans', 'ibm-plex-sans-latin-400-normal.woff2'],
    ['ibm-plex-sans', 'ibm-plex-sans-latin-600-normal.woff2'],
    ['ibm-plex-mono', 'ibm-plex-mono-latin-400-normal.woff2'],
    ['ibm-plex-mono', 'ibm-plex-mono-latin-500-normal.woff2'],
];

const IMAGES = [
    ['images/icon-32.png', 'images/icon-32.png'],
    ['images/icon-128.png', 'images/icon-128.png'],
    ['store/images/popup-options@2x.png', 'images/popup-options@2x.png'],
];

/**
 * @param {string} outDir
 * @returns {string[]} the files written, relative to `outDir`
 */
export function buildSite(outDir) {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.cpSync(path.join(ROOT, 'site'), outDir, { recursive: true });
    const written = fs.readdirSync(path.join(ROOT, 'site'));

    const copy = (from, to) => {
        fs.mkdirSync(path.dirname(path.join(outDir, to)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, from), path.join(outDir, to));
        written.push(to);
    };
    for (const [pkg, file] of FONTS) {
        copy(`node_modules/@fontsource/${pkg}/files/${file}`, `fonts/${file}`);
    }
    // The fonts are under the SIL Open Font License, which travels with them.
    for (const pkg of new Set(FONTS.map(([p]) => p))) {
        copy(`node_modules/@fontsource/${pkg}/LICENSE`, `fonts/LICENSE-${pkg}.txt`);
    }
    for (const [from, to] of IMAGES) {
        copy(from, to);
    }
    return written.sort();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const outIndex = process.argv.indexOf('--out');
    const outDir = path.resolve(outIndex > 0 ? process.argv[outIndex + 1] : path.join(ROOT, 'dist/site'));
    const files = buildSite(outDir);
    console.log(`${path.relative(process.cwd(), outDir)}: ${files.length} files`);
}
