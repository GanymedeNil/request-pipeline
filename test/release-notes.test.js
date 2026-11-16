import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { releaseNotes } from '../scripts/release-notes.js';

const changelog = `# Changelog

## [1.3.0] - Unreleased

### Added

- Something new.

## [1.2.0] - 2026-11-20

### Added

- Start and Stop buttons.

### Fixed

- A bug.

## [1.0.2] - 2024-04-04

- Older.

[1.3.0]: https://example.test/compare
[1.2.0]: https://example.test/compare
`;

test('returns the section for the tag, without its heading or the next one', () => {
    assert.equal(
        releaseNotes({ tag: 'v1.2.0', manifestVersion: '1.2.0', changelog }),
        '### Added\n\n- Start and Stop buttons.\n\n### Fixed\n\n- A bug.',
    );
});

test('stops at the link references after the last section', () => {
    const lastOnly = changelog.replace(/## \[1\.0\.2\][\s\S]*?(?=\[1\.3\.0\]:)/, '');
    assert.equal(
        releaseNotes({ tag: 'v1.2.0', manifestVersion: '1.2.0', changelog: lastOnly }),
        '### Added\n\n- Start and Stop buttons.\n\n### Fixed\n\n- A bug.',
    );
});

test('refuses a tag that does not match manifest.json', () => {
    assert.throws(
        () => releaseNotes({ tag: 'v1.2.1', manifestVersion: '1.2.0', changelog }),
        /does not match manifest\.json version 1\.2\.0/,
    );
});

test('refuses a section that is still marked Unreleased', () => {
    assert.throws(
        () => releaseNotes({ tag: 'v1.3.0', manifestVersion: '1.3.0', changelog }),
        /Give the CHANGELOG\.md heading a release date/,
    );
});

test('refuses a version with no section', () => {
    assert.throws(
        () => releaseNotes({ tag: 'v9.0.0', manifestVersion: '9.0.0', changelog }),
        /has no "## \[9\.0\.0\]" section/,
    );
});

test("the repository's CHANGELOG has a section for the manifest version", () => {
    const root = path.resolve(import.meta.dirname, '..');
    const { version } = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const text = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    assert.ok(text.includes(`## [${version}]`), `CHANGELOG.md needs a "## [${version}]" section`);
});
