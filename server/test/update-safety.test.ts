/**
 * Data-safety regression checks for install/update (FR-INSTALL-4, FR-INSTALL-5,
 * NFR-1b): starting the server against an existing data directory — which is
 * what happens after an update — must never overwrite notes or settings, and a
 * release that adds a config key must fill it from defaults without discarding
 * user-set values.
 *
 * Run with: npm test
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cases: { name: string; run: () => Promise<void> | void }[] = [];
const test = (name: string, run: () => Promise<void> | void) => cases.push({ name, run });

/** Load a fresh copy of config.ts bound to `dataDir` (read at import time). */
async function loadConfigModule(dataDir: string) {
  process.env.MNEMO_DATA_DIR = dataDir;
  // A cache-busting query gives each case its own module instance.
  return import(`../src/config.ts?d=${encodeURIComponent(dataDir)}`);
}

function newDataDir(): string {
  return join(mkdtempSync(join(tmpdir(), 'mnemo-update-')), 'data');
}

test('a fresh install seeds data/ from templates/ (FR-INSTALL-3)', async () => {
  const dataDir = newDataDir();
  const { loadConfig } = await loadConfigModule(dataDir);
  const config = loadConfig();

  assert.equal(config.ai.type, 'agent-cli', 'default backend (FR-SETTINGS-5)');
  assert.equal(config.ai.outputLanguage, 'ja', 'default output language (FR-SETTINGS-5)');
  assert.ok(existsSync(join(dataDir, 'notes', 'inbox')), 'starter notes seeded');
  assert.ok(existsSync(join(dataDir, 'config.json')), 'config.json seeded');
  rmSync(dataDir, { recursive: true, force: true });
});

test('an update never overwrites existing notes or config.json (FR-INSTALL-4)', async () => {
  const dataDir = newDataDir();
  const { loadConfig } = await loadConfigModule(dataDir);
  loadConfig(); // first run: seed

  // User content, as it would exist before an update.
  const notePath = join(dataDir, 'notes', 'wiki', 'subtopic', 'my-note.md');
  mkdirSync(join(dataDir, 'notes', 'wiki', 'subtopic'), { recursive: true });
  writeFileSync(notePath, '---\ntitle: Mine\n---\n\nkeep me\n', 'utf8');
  const assetPath = join(dataDir, 'assets', 'images', 'pic.bin');
  writeFileSync(assetPath, 'binary', 'utf8');
  const jobPath = join(dataDir, 'jobs', 'jobs.json');
  writeFileSync(jobPath, '[{"id":"j1"}]', 'utf8');
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify({ port: 4321, ai: { type: 'claude-code', outputLanguage: 'en' } }, null, 2),
    'utf8'
  );

  // Restarting after an update re-runs seeding + layout creation.
  const { loadConfig: reload } = await loadConfigModule(dataDir);
  const config = reload();

  assert.equal(readFileSync(notePath, 'utf8'), '---\ntitle: Mine\n---\n\nkeep me\n');
  assert.equal(readFileSync(assetPath, 'utf8'), 'binary');
  assert.equal(readFileSync(jobPath, 'utf8'), '[{"id":"j1"}]');
  assert.equal(config.port, 4321, 'user port preserved');
  assert.equal(config.ai.type, 'claude-code', 'user backend preserved');
  assert.equal(config.ai.outputLanguage, 'en', 'user output language preserved');
  rmSync(dataDir, { recursive: true, force: true });
});

test('new default config keys are filled without discarding user values (FR-INSTALL-5)', async () => {
  const dataDir = newDataDir();
  const { loadConfig } = await loadConfigModule(dataDir);
  loadConfig();

  // An older config that predates a backend/key added by a later release.
  writeFileSync(
    join(dataDir, 'config.json'),
    JSON.stringify({ ai: { type: 'agent-cli', backends: { 'agent-cli': { model: 'mine' } } } }),
    'utf8'
  );

  const { loadConfig: reload } = await loadConfigModule(dataDir);
  const config = reload();

  assert.equal(config.ai.backends['agent-cli'].model, 'mine', 'user backend setting wins');
  assert.ok(config.ai.backends['claude-code'], 'missing backend filled from defaults');
  assert.equal(config.ai.outputLanguage, 'ja', 'missing key filled from defaults');
  assert.equal(config.port, 3000, 'missing port filled from defaults');
  rmSync(dataDir, { recursive: true, force: true });
});

test('install.sh never lists data/ or node_modules/ among updated paths (NFR-1b)', () => {
  const script = readFileSync(new URL('../../install.sh', import.meta.url), 'utf8');
  const paths = /SOURCE_PATHS="([\s\S]*?)"/.exec(script);
  assert.ok(paths, 'SOURCE_PATHS is defined');
  const entries = paths[1].replace(/\\\n/g, ' ').split(/\s+/).filter(Boolean);
  assert.ok(entries.includes('server') && entries.includes('web'), 'source is updated');
  for (const forbidden of ['data', 'data/', 'node_modules', 'node_modules/']) {
    assert.ok(!entries.includes(forbidden), `${forbidden} must never be updated`);
  }
  assert.match(script, /pull --ff-only/, 'git updates are fast-forward only');
  assert.doesNotMatch(script, /rm -rf "\$TARGET_DIR/, 'the updater never deletes inside the install');
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
