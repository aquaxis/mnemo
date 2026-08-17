/**
 * Checks for turning a chat message into a scheduled task (FR-CHAT-9).
 *
 * Two things must hold: an ordinary question must never become a job (the
 * pre-filter and the `isTask` flag both guard that), and a model answer that is
 * malformed, incomplete or carries an impossible schedule must be rejected
 * rather than persisted as a bogus job.
 *
 * Run with: npm test
 */
import assert from 'node:assert/strict';

import { mentionsCadence, parseProposal } from '../src/agent/task-proposal.js';

const cases: { name: string; run: () => Promise<void> | void }[] = [];
const test = (name: string, run: () => Promise<void> | void) => cases.push({ name, run });

test('recurring requests are recognized, ordinary questions are not', () => {
  for (const text of [
    '毎朝8時にAIニュースを調べてまとめて',
    '毎週月曜に競合の価格を確認して',
    'every morning, summarize the AI news',
    'Check the release notes daily and save a summary',
    '定期的にRustのリリース情報を集めて',
    '3日おきに天気をまとめて'
  ]) {
    assert.equal(mentionsCadence(text), true, `should match: ${text}`);
  }

  for (const text of [
    'Fastifyの最新版を教えて',
    'What is the capital of France?',
    'このノートを要約して',
    'ありがとう'
  ]) {
    assert.equal(mentionsCadence(text), false, `should not match: ${text}`);
  }
});

test('a valid proposal is accepted and normalized', () => {
  const proposal = parseProposal(
    '```json\n' +
      JSON.stringify({
        isTask: true,
        name: 'AI news briefing',
        cron: '0 8 * * *',
        instruction: 'Research the latest AI news on the web and write a briefing.',
        category: '/collected/'
      }) +
      '\n```'
  );

  assert.ok(proposal, 'accepted');
  assert.equal(proposal.cron, '0 8 * * *');
  assert.equal(proposal.category, 'collected', 'stray slashes trimmed');
  assert.match(proposal.instruction, /Research the latest AI news/);
});

test('the name falls back to the instruction and stays short', () => {
  const long = 'A'.repeat(200);
  const proposal = parseProposal(
    JSON.stringify({ isTask: true, cron: '0 8 * * *', instruction: long })
  );

  assert.ok(proposal, 'accepted without a name');
  assert.equal(proposal.name.length, 60, 'name is truncated');
  assert.equal(proposal.category, 'collected', 'category defaults');
});

test('non-task answers and malformed proposals are rejected', () => {
  const rejected: Array<[string, string]> = [
    ['not a task', JSON.stringify({ isTask: false, cron: '0 8 * * *', instruction: 'x' })],
    ['no instruction', JSON.stringify({ isTask: true, cron: '0 8 * * *', instruction: '  ' })],
    ['invalid cron', JSON.stringify({ isTask: true, cron: 'every morning', instruction: 'x' })],
    ['missing cron', JSON.stringify({ isTask: true, instruction: 'x' })],
    ['not JSON', 'Sure! I have scheduled that for you.'],
    ['broken JSON', '{"isTask": true, "cron": ']
  ];

  for (const [why, raw] of rejected) {
    assert.equal(parseProposal(raw), null, `rejected: ${why}`);
  }
});

test('a proposal wrapped in prose is still read', () => {
  const proposal = parseProposal(
    'Here you go:\n' +
      JSON.stringify({
        isTask: true,
        name: 'Weekly prices',
        cron: '0 9 * * 1',
        instruction: 'Check competitor pricing and record the changes.',
        category: 'collected'
      }) +
      '\nHope that helps!'
  );

  assert.ok(proposal, 'accepted');
  assert.equal(proposal.cron, '0 9 * * 1');
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
