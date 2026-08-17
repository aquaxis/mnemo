/**
 * Backend-fault regression checks (FR-CHAT-6, FR-REL-1..6, NFR-7).
 *
 * The reported defect was that a chat message produced no reply *and* the whole
 * web server stopped answering. Each case here drives one of the failure modes
 * that could do that — a missing command, a child that exits before reading the
 * prompt, a child that never exits, a child that floods stdout, and logging to
 * a terminal that has gone away — and asserts that the invocation is contained
 * and this process is still alive afterwards.
 *
 * Run with: npm test
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCli, RunLimiter, BackendError, commandExists } from '../src/agent/run-cli.js';
import { createLogStream } from '../src/log.js';
import type { AppConfig } from '../src/config.js';

const cases: { name: string; run: () => Promise<void> | void }[] = [];
const test = (name: string, run: () => Promise<void> | void) => cases.push({ name, run });

const LIMITS = { timeoutMs: 5000, maxOutputBytes: 1000000 };

test('a missing backend command is reported, not thrown (FR-REL-2)', async () => {
  const err = await runCli({
    command: 'mnemo-no-such-command',
    args: [],
    prompt: 'hello\n',
    ...LIMITS
  }).then(
    () => null,
    (e) => e as BackendError
  );

  assert.ok(err instanceof BackendError, 'rejects with a BackendError');
  assert.equal(err.reason, 'not-found');
  assert.match(err.message, /not found/i, 'the message tells the user what to fix');
});

test('a child that exits before reading the prompt cannot crash the server (FR-REL-2)', async () => {
  // 8 MB of prompt against a child that exits at once: the write fails with
  // EPIPE / ERR_STREAM_DESTROYED, which unhandled would kill the process.
  const result = await runCli({
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    prompt: 'x'.repeat(8 * 1024 * 1024),
    ...LIMITS
  }).then(
    () => 'settled',
    (e) => (e instanceof BackendError ? `rejected:${e.reason}` : `unexpected:${String(e)}`)
  );

  assert.ok(
    result === 'settled' || result === 'rejected:io' || result === 'rejected:exit',
    `the invocation settles cleanly (got ${result})`
  );
});

test('a backend that never answers is stopped by the timeout (FR-REL-1, FR-CHAT-6)', async () => {
  const startedAt = Date.now();
  const err = await runCli({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'], // never exits, never answers
    prompt: 'hello\n',
    timeoutMs: 700,
    maxOutputBytes: LIMITS.maxOutputBytes
  }).then(
    () => null,
    (e) => e as BackendError
  );

  assert.ok(err instanceof BackendError, 'rejects instead of hanging forever');
  assert.equal(err.reason, 'timeout');
  assert.ok(Date.now() - startedAt < 5000, 'it gives up at the configured limit');
});

test('runaway output is capped instead of exhausting memory (FR-REL-3)', async () => {
  const result = await runCli({
    command: process.execPath,
    // Flood stdout from a timer so the writes actually reach the parent.
    args: ['-e', 'setInterval(() => process.stdout.write("x".repeat(64 * 1024)), 1);'],
    prompt: '',
    timeoutMs: 10000,
    maxOutputBytes: 200000
  });

  assert.equal(result.truncated, true, 'the run is marked truncated');
  assert.ok(result.stdout.length < 2000000, `output stayed bounded (${result.stdout.length} bytes)`);
});

test('a cancelled request stops the backend run (FR-CHAT-7)', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = runCli({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'], // would run until the timeout
    prompt: 'hello\n',
    timeoutMs: 30000,
    maxOutputBytes: LIMITS.maxOutputBytes,
    signal: controller.signal
  });
  setTimeout(() => controller.abort(), 200);

  const err = await pending.then(
    () => null,
    (e) => e as BackendError
  );

  assert.ok(err instanceof BackendError, 'the run rejects when cancelled');
  assert.equal(err.reason, 'cancelled');
  assert.ok(Date.now() - started < 5000, 'it stops at once, not at the timeout');
});

test('concurrent runs are limited and queued (FR-REL-5)', async () => {
  const limiter = new RunLimiter(1);
  const order: string[] = [];
  const slow = (name: string, ms: number) =>
    limiter.run(async () => {
      order.push(`start:${name}`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`end:${name}`);
    }, 5000);

  await Promise.all([slow('a', 120), slow('b', 10)]);

  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b'], 'the second run waits');
});

test('work that cannot start in time fails fast instead of piling up (FR-REL-5)', async () => {
  const limiter = new RunLimiter(1);
  const blocker = limiter.run(() => new Promise((r) => setTimeout(r, 600)), 5000);
  const err = await limiter.run(async () => 'never', 100).then(
    () => null,
    (e) => e as BackendError
  );
  await blocker;

  assert.ok(err instanceof BackendError, 'queued work rejects rather than waiting forever');
  assert.equal(err.reason, 'busy');
});

test('the server logs to a file, not to the inherited terminal (FR-REL-4)', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mnemo-log-'));
  const config = {
    logTarget: 'file',
    logFile: join(dataDir, 'logs', 'mnemo.log')
  } as AppConfig;

  const stream = createLogStream(config);
  assert.notEqual(stream, process.stdout, 'logging never targets stdout by default');
  await new Promise<void>((resolve) => stream.write('hello\n', () => resolve()));
  assert.ok(existsSync(config.logFile), 'the log file is created');
  assert.match(readFileSync(config.logFile, 'utf8'), /hello/);

  rmSync(dataDir, { recursive: true, force: true });
});

test('an installed backend command is detected on PATH (FR-REL-6)', () => {
  assert.equal(commandExists('mnemo-no-such-command'), false);
  assert.equal(commandExists(process.execPath), true, 'an absolute executable resolves');
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
// The whole point: after every fault above, this process is still running.
console.log(`\n${cases.length - failed}/${cases.length} passed (server process survived)`);
process.exit(failed ? 1 : 0);
