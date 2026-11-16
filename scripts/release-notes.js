// Prints the CHANGELOG.md section for a release tag, after checking the tag matches manifest.json
// and the section has a release date. Used by .github/workflows/release.yml.
//
// Usage: node scripts/release-notes.js v1.2.0 > notes.md

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * @param {object} input
 * @param {string} input.tag e.g. "v1.2.0"
 * @param {string} input.manifestVersion version from manifest.json
 * @param {string} input.changelog contents of CHANGELOG.md
 * @returns {string} the section body, without its heading
 */
export function releaseNotes({ tag, manifestVersion, changelog }) {
    const version = tag.replace(/^v/, '');
    if (version !== manifestVersion) {
        throw new Error(`Tag ${tag} does not match manifest.json version ${manifestVersion}`);
    }
    const lines = changelog.split('\n');
    const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
    if (start === -1) {
        throw new Error(`CHANGELOG.md has no "## [${version}]" section`);
    }
    if (!/^## \[[^\]]+\] - \d{4}-\d{2}-\d{2}\s*$/.test(lines[start])) {
        throw new Error(
            `Give the CHANGELOG.md heading a release date: "${lines[start]}" -> "## [${version}] - YYYY-MM-DD"`,
        );
    }
    const end = lines.findIndex((line, i) => i > start && (line.startsWith('## ') || /^\[[^\]]+\]: /.test(line)));
    return lines
        .slice(start + 1, end === -1 ? undefined : end)
        .join('\n')
        .trim();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const tag = process.argv[2];
    if (!tag) {
        console.error('Usage: node scripts/release-notes.js <tag>');
        process.exit(2);
    }
    try {
        const notes = releaseNotes({
            tag,
            manifestVersion: JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version,
            changelog: fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'),
        });
        console.log(notes);
    } catch (err) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
    }
}
