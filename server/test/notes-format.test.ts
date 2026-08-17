/**
 * Note storage format checks (FR-NOTE-5, FR-NOTE-7, FR-NOTE-8, FR-NOTE-9).
 *
 * Notes are plain Markdown: no YAML block is ever written, the file name is the
 * title shown in the list, recency comes from the file's mtime, and a note
 * written by an earlier release — which still carries frontmatter — must keep
 * opening and must not be rewritten until the user saves it.
 *
 * Run with: npm test
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NoteStore, fileNameFor } from '../src/storage/notes.js';

const cases: { name: string; run: () => Promise<void> | void }[] = [];
const test = (name: string, run: () => Promise<void> | void) => cases.push({ name, run });

const now = () => new Date().toISOString();

function newStore(): { store: NoteStore; dataDir: string } {
  const dataDir = join(mkdtempSync(join(tmpdir(), 'mnemo-notes-')), 'data');
  return { store: new NoteStore(dataDir), dataDir };
}

test('a saved note is plain Markdown with no frontmatter (FR-NOTE-5)', () => {
  const { store, dataDir } = newStore();
  const note = store.create({ title: 'Release notes', category: 'wiki', body: '# Hi\n\nbody' }, now());

  const raw = readFileSync(join(dataDir, 'notes', 'wiki', `${note.id}.md`), 'utf8');
  assert.ok(!raw.startsWith('---'), 'no YAML block at the head');
  assert.equal(raw, '# Hi\n\nbody\n');

  store.update(note.id, { body: 'edited' }, now());
  const after = readFileSync(join(dataDir, 'notes', 'wiki', `${note.id}.md`), 'utf8');
  assert.equal(after, 'edited\n', 'updates stay frontmatter-free');
  rmSync(dataDir, { recursive: true, force: true });
});

test('the file is named after the title, and the title is the file name (FR-NOTE-7)', () => {
  const { store, dataDir } = newStore();

  const note = store.create({ title: 'Weekly Rust releases', category: 'wiki' }, now());
  assert.equal(note.id, 'Weekly Rust releases');
  assert.equal(note.title, note.id, 'the list shows the file name');
  assert.equal(readFileSync(join(dataDir, 'notes', 'wiki', 'Weekly Rust releases.md'), 'utf8'), '');

  // Japanese titles survive; only path-unsafe characters are replaced.
  const jp = store.create({ title: '毎朝のAIニュース/要約', category: 'wiki' }, now());
  assert.equal(jp.id, '毎朝のAIニュース 要約');

  // Same name twice → the second gets a suffix rather than overwriting.
  const dup = store.create({ title: 'Weekly Rust releases', category: 'wiki' }, now());
  assert.equal(dup.id, 'Weekly Rust releases-2');
  rmSync(dataDir, { recursive: true, force: true });
});

test('renaming a note renames its file (FR-NOTE-7)', () => {
  const { store, dataDir } = newStore();
  const note = store.create({ title: 'Draft', category: 'inbox', body: 'keep me' }, now());

  const renamed = store.update(note.id, { title: 'Final report' }, now());
  assert.ok(renamed);
  assert.equal(renamed.id, 'Final report');
  assert.equal(renamed.body, 'keep me', 'content follows the rename');
  assert.equal(store.get('Draft'), null, 'the old name is gone');
  assert.equal(
    readFileSync(join(dataDir, 'notes', 'inbox', 'Final report.md'), 'utf8'),
    'keep me\n'
  );
  rmSync(dataDir, { recursive: true, force: true });
});

test('notes are ordered by file modification time (FR-NOTE-8, FR-UI-9)', () => {
  const { store, dataDir } = newStore();
  for (const title of ['first', 'second', 'third']) {
    store.create({ title, category: 'inbox', body: title }, now());
  }
  // Notes created within the same millisecond share an mtime, so set the
  // timestamps explicitly: "first" newest, then "third", then "second".
  const stamp = (name: string, offsetMs: number) => {
    const t = new Date(Date.now() + offsetMs);
    utimesSync(join(dataDir, 'notes', 'inbox', `${name}.md`), t, t);
  };
  stamp('first', 60_000);
  stamp('third', 30_000);
  stamp('second', 10_000);

  assert.deepEqual(
    store.list('inbox').map((n) => n.id),
    ['first', 'third', 'second'],
    'newest mtime first'
  );
  rmSync(dataDir, { recursive: true, force: true });
});

test('a legacy frontmatter note still opens and keeps its content (FR-NOTE-9)', () => {
  const { store, dataDir } = newStore();
  const dir = join(dataDir, 'notes', 'collected');
  mkdirSync(dir, { recursive: true });
  const legacy = join(dir, 'old-note.md');
  const original =
    '---\nid: 1234\ntitle: Old note\ntags: [a]\nupdated: 2020-01-01T00:00:00.000Z\n---\n\nThe body survives.\n';
  writeFileSync(legacy, original, 'utf8');

  const read = store.get('old-note');
  assert.ok(read, 'the legacy note opens');
  assert.equal(read.title, 'old-note', 'title comes from the file name');
  assert.equal(read.body, 'The body survives.', 'the YAML block is hidden from the editor');
  assert.equal(readFileSync(legacy, 'utf8'), original, 'the file is untouched until saved');

  store.update('old-note', { body: read.body }, now());
  assert.equal(
    readFileSync(legacy, 'utf8'),
    'The body survives.\n',
    'saving drops the frontmatter'
  );
  rmSync(dataDir, { recursive: true, force: true });
});

test('unsafe or empty titles still produce a usable file name (FR-NOTE-7)', () => {
  assert.equal(fileNameFor('a/b\\c:d*e?f'), 'a b c d e f');
  assert.equal(fileNameFor('   '), 'Untitled');
  assert.equal(fileNameFor(undefined), 'Untitled');
  assert.equal(fileNameFor('...hidden...'), 'hidden');
  assert.equal(fileNameFor('Rust 1.93 released'), 'Rust 1.93 released', 'digits survive');
  assert.ok(fileNameFor('x'.repeat(200)).length <= 80, 'long titles are capped');
});

let failed = 0;
for (const c of cases) {
  try {
    await c.run();
    console.log(`ok   ${c.name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${c.name}\n     ${(err as Error).message}`);
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
