import cron from 'node-cron';
import type { AiProvider, ChatMessage } from './provider.js';

/** A scheduled task the AI derived from a chat message (FR-CHAT-9). */
export interface JobProposal {
  name: string;
  cron: string;
  instruction: string;
  category: string;
}

/**
 * Words that suggest the user is asking for something *recurring*. Only such
 * messages pay for the extra AI round-trip (FR-CHAT-9 pre-filter): an ordinary
 * question must not become slower or more expensive because the feature exists.
 *
 * Kept deliberately broad — a false positive costs one analysis whose `isTask`
 * comes back false, while a false negative silently drops the feature.
 */
const CADENCE_PATTERNS: RegExp[] = [
  // English
  /\bevery\s+(day|morning|evening|night|week|month|hour|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d)/i,
  /\b(daily|weekly|monthly|hourly|nightly)\b/i,
  /\beach\s+(day|morning|week|month)\b/i,
  /\b(schedule|recurring|periodically|regularly|cron)\b/i,
  // Japanese
  /毎(日|朝|晩|夜|週|月|時|年)/,
  /定期的?に/,
  /(スケジュール|cron|クーロン)/i,
  /[一二三四五六七八九十\d]+(日|週間?|ヶ月|か月|時間)おきに/,
  /(月|火|水|木|金|土|日)曜日?(に|の)/
];

/** Cheap check: could this message be asking for a recurring task? */
export function mentionsCadence(text: string): boolean {
  return CADENCE_PATTERNS.some((re) => re.test(text));
}

const PROPOSAL_PROMPT = (message: string) =>
  `Decide whether the following user message asks for a RECURRING, SCHEDULED ` +
  `task (something to be run again and again on a schedule), as opposed to a ` +
  `one-off question or request.\n\n` +
  `Reply with JSON only — no prose, no code fences — in exactly this shape:\n` +
  `{"isTask": true|false, "name": "...", "cron": "...", "instruction": "...", "category": "..."}\n\n` +
  `Rules:\n` +
  `- "isTask" is false for anything that is not a recurring scheduled task; ` +
  `then the other fields may be empty.\n` +
  `- "instruction" must be a self-contained task description an AI agent can ` +
  `execute on its own later, written in the imperative. Drop the scheduling ` +
  `words from it (they belong in "cron") and keep every detail about WHAT to ` +
  `do, including the topic, the sources to prefer and the output expected.\n` +
  `- "cron" is a 5-field cron expression (minute hour day month weekday) for ` +
  `the cadence the user asked for. Use 8am if they say "morning" without a ` +
  `time, and "0 8 * * *" when the cadence is vague.\n` +
  `- "name" is a short title (at most 60 characters) for the task.\n` +
  `- "category" is the notes folder to save results in; use "collected" ` +
  `unless the user names one.\n\n` +
  `User message:\n${message}`;

/**
 * Ask the AI backend whether `message` requests a recurring task and, if so, to
 * rewrite it as a proper agent instruction plus a schedule (FR-CHAT-9).
 * Returns null when it is not a task request, when the backend fails, or when
 * the proposal does not validate — the chat reply is never blocked by this.
 */
export async function proposeJob(
  provider: AiProvider,
  message: string,
  signal?: AbortSignal
): Promise<JobProposal | null> {
  if (!mentionsCadence(message)) return null;

  const history: ChatMessage[] = [{ role: 'user', content: PROPOSAL_PROMPT(message) }];
  const raw = await provider.chat(history, signal);
  return parseProposal(raw);
}

/**
 * Validate the model's answer: it must be JSON claiming a task, carry an
 * instruction, and name a schedule node-cron accepts. Anything else is
 * rejected so a stray reply cannot create a bogus job.
 */
export function parseProposal(raw: string): JobProposal | null {
  const json = extractJson(raw);
  if (!json) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (parsed.isTask !== true) return null;

  const instruction = str(parsed.instruction);
  if (!instruction) return null;

  const cronExpr = str(parsed.cron);
  if (!cronExpr || !cron.validate(cronExpr)) return null;

  const name = str(parsed.name) || firstLine(instruction);
  const category = str(parsed.category) || 'collected';

  return {
    name: name.slice(0, 60),
    cron: cronExpr,
    instruction,
    category: category.replace(/^\/+|\/+$/g, '') || 'collected'
  };
}

/** Pull the first JSON object out of a reply that may carry prose or fences. */
function extractJson(raw: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const text = fenced ? fenced[1] : raw;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find(Boolean) ?? 'Scheduled task';
}
