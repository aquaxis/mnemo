import type { AiConfig, AiBackendSettings, AiBackendType } from '../config.js';
import { BackendError, RunLimiter, commandExists, runCli } from './run-cli.js';

export { BackendError, commandExists } from './run-cli.js';

/** Diagnostics sink; set by the server so backend faults are logged (FR-REL-6). */
export type LogFn = (message: string, detail: Record<string, unknown>) => void;

let logFn: LogFn = () => {};

export function setProviderLogger(log: LogFn): void {
  logFn = log;
}

/**
 * Shared across providers so chat, collection, and scheduled runs together stay
 * within `ai.maxConcurrentRuns` (FR-REL-5).
 */
const limiter = new RunLimiter(2);

export interface Summary {
  keypoints: string[];
  summary: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Abstraction over AI backends (NFR-6, FR-AI-3). */
export interface AiProvider {
  readonly type: AiBackendType;
  /** Summarize a web page into key points + a summary. */
  summarize(title: string, text: string): Promise<Summary>;
  /** Execute a natural-language task instruction, returning Markdown (FR-CRON-7). */
  execute(instruction: string, context: string): Promise<string>;
  /** Hold a conversation with the AI agent, returning the reply (FR-CHAT). */
  chat(messages: ChatMessage[]): Promise<string>;
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  ja: 'Japanese',
  zh: 'Chinese',
  ko: 'Korean',
  es: 'Spanish',
  fr: 'French',
  de: 'German'
};

function languageName(lang: string): string {
  return LANGUAGE_NAMES[lang] ?? lang;
}

const PROMPT = (title: string, text: string, lang: string) =>
  `Summarize the following web page titled "${title}". ` +
  `Return 3-5 concise key points as a Markdown bullet list ("- "), ` +
  `then a one-paragraph summary. ` +
  `Write the key points and the summary in ${languageName(lang)}.` +
  `\n\n${text.slice(0, 12000)}`;

/** Prompt for a chat turn: system framing + conversation history (FR-CHAT). */
const CHAT_PROMPT = (messages: ChatMessage[], lang: string) =>
  `You are Mnemo's helpful AI assistant. Respond in ${languageName(lang)}. ` +
  `The user's notes are Markdown files under the current working directory ` +
  `(subfolders per category); you may search and read them to answer (FR-FILE-6).\n\n` +
  messages.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n') +
  `\nAssistant:`;

/** Prompt for executing an arbitrary agent task instruction (FR-CRON-7). */
const INSTRUCTION_PROMPT = (instruction: string, context: string, lang: string) =>
  `You are an AI agent. Perform the following task and return the result as ` +
  `Markdown. Write the result in ${languageName(lang)}.\n\n` +
  `Task:\n${instruction}\n` +
  (context
    ? `\nYou may use the following collected source material as context:\n\n${context.slice(0, 12000)}\n`
    : '');

/** Parse an LLM/CLI text response into { keypoints, summary }. */
function parseSummary(out: string, fallbackTitle: string): Summary {
  const lines = out.split('\n');
  const keypoints = lines
    .filter((l) => /^\s*[-*]\s+/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
    .filter(Boolean);
  const summary = lines
    .filter((l) => l.trim() && !/^\s*[-*]\s+/.test(l) && !/^\s*#{1,6}\s/.test(l))
    .join(' ')
    .trim();
  return {
    keypoints: keypoints.length ? keypoints : [summary || fallbackTitle],
    summary: summary || out.trim() || fallbackTitle
  };
}

/** Per-invocation limits taken from the AI config (FR-REL-1, FR-REL-3, FR-REL-5). */
export interface RunLimits {
  timeoutMs: number;
  maxOutputBytes: number;
}

/**
 * Run a CLI backend through the hardened runner: bounded in time, capped in
 * output, contained against spawn/stdin failures, and queued behind the shared
 * concurrency limiter (FR-REL-1..3, FR-REL-5). `cwd` (the notes directory) lets
 * the agent's own file tools search/read the note corpus (FR-FILE-6).
 */
async function runBackend(
  command: string,
  args: string[],
  prompt: string,
  cwd: string | undefined,
  limits: RunLimits
): Promise<string> {
  const started = Date.now();
  const result = await limiter.run(
    () =>
      runCli({
        command,
        args,
        prompt,
        cwd,
        timeoutMs: limits.timeoutMs,
        maxOutputBytes: limits.maxOutputBytes,
        log: logFn
      }),
    limits.timeoutMs
  );
  logFn('AI backend invocation finished', {
    command: [command, ...args].join(' '),
    durationMs: Date.now() - started,
    truncated: result.truncated,
    bytes: result.stdout.length
  });
  return result.stdout;
}

/** Local, dependency-free heuristic (local-first, FR-AI-5 fallback). */
export class LocalProvider implements AiProvider {
  readonly type = 'local' as const;
  async summarize(title: string, text: string): Promise<Summary> {
    const sentences = text
      .replace(/\n+/g, ' ')
      .split(/(?<=[.!?。！？])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 40);
    return {
      keypoints: sentences.slice(0, 5),
      summary: sentences.slice(0, 3).join(' ') || title
    };
  }

  /**
   * The local backend has no LLM, so it cannot truly "execute" an instruction;
   * it returns the task text plus a heuristic summary of any provided context.
   */
  async execute(instruction: string, context: string): Promise<string> {
    const { keypoints, summary } = await this.summarize(instruction || 'Task', context);
    const points = context ? keypoints.map((k) => `- ${k}`).join('\n') : '- (no sources provided)';
    return (
      `> Local mode has no AI agent; showing the task and a heuristic summary of the sources.\n\n` +
      `## Task\n\n${instruction || '(none)'}\n\n` +
      `## Key points\n\n${points}\n\n` +
      `## Summary\n\n${context ? summary : '(no sources to summarize)'}\n`
    );
  }

  async chat(): Promise<string> {
    return (
      'No AI backend is configured (local mode has no chat). ' +
      'Choose a backend — agent-cli or Claude Code — on the Settings page.'
    );
  }
}

/**
 * Base for real AI backends. Subclasses implement the transport `complete()`;
 * `summarize`/`execute`/`chat` are built on top and fall back to the local
 * heuristic if the backend throws (FR-AI-5). `notesDir` is the working directory
 * given to the CLI so the agent can search/read all notes (FR-FILE-6).
 */
abstract class RemoteProvider implements AiProvider {
  abstract readonly type: AiBackendType;
  constructor(
    protected readonly lang: string,
    protected readonly limits: RunLimits,
    protected readonly notesDir?: string
  ) {}

  /** Send a prompt to the backend and return its raw text output. */
  protected abstract complete(prompt: string): Promise<string>;

  async summarize(title: string, text: string): Promise<Summary> {
    try {
      return parseSummary(await this.complete(PROMPT(title, text, this.lang)), title);
    } catch (err) {
      // Degrade to the local heuristic (FR-AI-5) but never silently: the cause
      // must be visible in the log (FR-REL-6).
      logFn('AI summarization failed; using the local heuristic', {
        backend: this.type,
        error: errorText(err)
      });
      return new LocalProvider().summarize(title, text);
    }
  }

  async execute(instruction: string, context: string): Promise<string> {
    try {
      return (await this.complete(INSTRUCTION_PROMPT(instruction, context, this.lang))).trim();
    } catch (err) {
      logFn('AI task execution failed; using the local heuristic', {
        backend: this.type,
        error: errorText(err)
      });
      const fallback = await new LocalProvider().execute(instruction, context);
      return `> ⚠️ The ${this.type} backend failed: ${errorText(err)}\n\n${fallback}`;
    }
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    try {
      const reply = (await this.complete(CHAT_PROMPT(messages, this.lang))).trim();
      return reply || `⚠️ The ${this.type} backend returned an empty response.`;
    } catch (err) {
      logFn('AI chat failed', { backend: this.type, error: errorText(err) });
      return `⚠️ ${errorText(err)}`;
    }
  }
}

function errorText(err: unknown): string {
  if (err instanceof BackendError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** agent-cli backend (https://github.com/aquaxis/agent-cli). */
export class AgentCliProvider extends RemoteProvider {
  readonly type = 'agent-cli' as const;
  constructor(
    private readonly s: AiBackendSettings,
    lang: string,
    limits: RunLimits,
    notesDir?: string
  ) {
    super(lang, limits, notesDir);
  }
  protected async complete(prompt: string): Promise<string> {
    // agent-cli `run` is a REPL that reads stdin line by line, so the prompt is
    // flattened to a single line (with a trailing newline to submit it).
    const oneLine = prompt.replace(/\s*\n\s*/g, ' ').trim();
    const raw = await runBackend(
      this.s.command ?? 'agent-cli',
      this.s.args ?? ['run', '--auto-approve-tools'],
      `${oneLine}\n`,
      this.notesDir,
      this.limits
    );
    return cleanAgentCliOutput(raw);
  }
}

/**
 * agent-cli's REPL prints a startup banner ("agent-cli ready", indented
 * "  key : value" lines, "type /help …") and prefixes response lines with "> "
 * (sometimes an "[answer]" marker). Strip all of that to leave the answer text.
 */
function cleanAgentCliOutput(raw: string): string {
  return raw
    .split('\n')
    .filter((l) => !/^agent-cli ready/.test(l))
    .filter((l) => !/^\s{2,}\w+\s*:/.test(l)) // banner "  id : …"
    .filter((l) => !/^type \/help for commands/.test(l))
    .map((l) => l.replace(/^(\s*>\s*)+/, '')) // strip "> " prompt markers
    .filter((l) => l.trim() !== '[answer]')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Claude Code CLI backend, invoked in print/headless mode. */
export class ClaudeCodeProvider extends RemoteProvider {
  readonly type = 'claude-code' as const;
  constructor(
    private readonly s: AiBackendSettings,
    lang: string,
    limits: RunLimits,
    notesDir?: string
  ) {
    super(lang, limits, notesDir);
  }
  protected complete(prompt: string): Promise<string> {
    return runBackend(
      this.s.command ?? 'claude',
      this.s.args ?? ['-p'],
      prompt,
      this.notesDir,
      this.limits
    );
  }
}

/**
 * Instantiate the provider selected by config.ai.type (FR-AI-1, FR-AI-2).
 * Selectable backends are agent-cli and Claude Code; `local` is the internal
 * fallback. The Claude API is not a backend (C-11 / FR-AI-6). `notesDir` gives
 * the CLI agents access to the note corpus for search (FR-FILE-6).
 */
export function createProvider(config: AiConfig, notesDir?: string): AiProvider {
  const s = config.backends[config.type] ?? {};
  const lang = config.outputLanguage ?? 'en';
  const limits: RunLimits = {
    timeoutMs: config.timeoutMs,
    maxOutputBytes: config.maxOutputBytes
  };
  limiter.setLimit(config.maxConcurrentRuns);
  switch (config.type) {
    case 'agent-cli':
      return new AgentCliProvider(s, lang, limits, notesDir);
    case 'claude-code':
      return new ClaudeCodeProvider(s, lang, limits, notesDir);
    default:
      return new LocalProvider();
  }
}

/**
 * Whether the command backing a backend is present on PATH (FR-REL-6): the
 * Settings page reports a missing backend instead of failing per message.
 */
export function backendAvailable(config: AiConfig, type: AiBackendType): boolean {
  if (type === 'local') return true;
  const defaults: Record<string, string> = { 'agent-cli': 'agent-cli', 'claude-code': 'claude' };
  return commandExists(config.backends[type]?.command ?? defaults[type] ?? '');
}
