import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Repository root (server/src -> ../../). */
export const ROOT_DIR = resolve(__dirname, '..', '..');
export const TEMPLATES_DIR = join(ROOT_DIR, 'templates');
export const WEB_DIST_DIR = join(ROOT_DIR, 'web', 'dist');

/** AI backend types. `local` is the internal heuristic fallback (FR-AI-5). */
export type AiBackendType = 'agent-cli' | 'claude-code' | 'local';

/** User-selectable backends (FR-AI-1, C-8); `local` is fallback-only, excluded. */
export const AI_BACKENDS: AiBackendType[] = ['agent-cli', 'claude-code'];

/** Per-backend settings (FR-AI-4). */
export interface AiBackendSettings {
  command?: string;
  args?: string[];
  model?: string | null;
}

export interface AiConfig {
  /** The active backend used for summarization (FR-AI-2). */
  type: AiBackendType;
  /** Language for generated summaries, e.g. "en", "ja" (FR-SETTINGS-4). */
  outputLanguage: string;
  backends: Record<string, AiBackendSettings>;
  /** Hard limit for a single backend invocation, in ms (FR-REL-1). */
  timeoutMs: number;
  /** Cap on the output collected from a backend, in bytes (FR-REL-3). */
  maxOutputBytes: number;
  /** Maximum simultaneous agent invocations (FR-REL-5). */
  maxConcurrentRuns: number;
}

/**
 * Where the server writes its log. Writing to an inherited terminal or pipe is
 * *synchronous* in Node on POSIX: if that terminal goes away or stops draining,
 * every log write blocks the event loop and the whole server stops answering
 * (FR-REL-4). Logging therefore defaults to a file under the data directory;
 * `MNEMO_LOG=stdout` opts back into console logging for development.
 */
export type LogTarget = 'file' | 'stdout';

export interface AppConfig {
  port: number;
  dataDir: string;
  ai: AiConfig;
  logTarget: LogTarget;
  logFile: string;
}

const DEFAULT_BACKENDS: Record<string, AiBackendSettings> = {
  'agent-cli': { command: 'agent-cli', args: ['run', '--auto-approve-tools'], model: null },
  'claude-code': { command: 'claude', args: ['-p'], model: null },
  local: {}
};

// Shipped defaults: agent-cli backend and Japanese output (FR-SETTINGS-5).
// agent-cli uses its own configured provider (e.g. ollama glm-5.1:cloud).
/**
 * Reliability defaults (FR-REL-1, FR-REL-3, FR-REL-5). The timeout is sized for
 * a *research* answer (FR-CHAT-8): the agent runs several searches and opens
 * multiple pages before replying, which routinely takes minutes — measured runs
 * on a cloud model ranged from seconds to ~1.5 min for a plain answer.
 */
const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_MAX_OUTPUT_BYTES = 2000000;
const DEFAULT_MAX_CONCURRENT_RUNS = 2;

const DEFAULT_DATA_DIR = process.env.MNEMO_DATA_DIR ?? join(ROOT_DIR, 'data');

const DEFAULTS: AppConfig = {
  port: Number(process.env.MNEMO_PORT ?? 3000),
  dataDir: DEFAULT_DATA_DIR,
  ai: {
    type: (process.env.MNEMO_AI_TYPE as AiBackendType) ?? 'agent-cli',
    outputLanguage: process.env.MNEMO_AI_LANG ?? 'ja',
    backends: DEFAULT_BACKENDS,
    timeoutMs: Number(process.env.MNEMO_AI_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS),
    maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
    maxConcurrentRuns: DEFAULT_MAX_CONCURRENT_RUNS
  },
  logTarget: process.env.MNEMO_LOG === 'stdout' ? 'stdout' : 'file',
  logFile: join(DEFAULT_DATA_DIR, 'logs', 'mnemo.log')
};

/** A positive finite number from the config file, or the default. */
function positive(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Seed the data directory from templates/ on first run (FR-INSTALL-3, T-7.2).
 * Only copies when the data directory is missing or empty.
 */
function seedDataDir(dataDir: string): void {
  const isEmpty = !existsSync(dataDir) || readdirSync(dataDir).length === 0;
  if (!isEmpty) return;
  mkdirSync(dataDir, { recursive: true });
  const templateNotes = join(TEMPLATES_DIR, 'notes');
  if (existsSync(templateNotes)) {
    cpSync(templateNotes, join(dataDir, 'notes'), { recursive: true });
  }
  const exampleConfig = join(TEMPLATES_DIR, 'config.example.json');
  const targetConfig = join(dataDir, 'config.json');
  if (existsSync(exampleConfig) && !existsSync(targetConfig)) {
    cpSync(exampleConfig, targetConfig);
  }
}

/** Ensure the runtime data layout exists (FR-FILE-*, T-1.1). */
function ensureLayout(dataDir: string): void {
  for (const dir of [
    join(dataDir, 'notes'),
    join(dataDir, 'notes', 'inbox'),
    join(dataDir, 'notes', 'wiki'),
    join(dataDir, 'notes', 'collected'),
    join(dataDir, 'assets', 'images'),
    join(dataDir, 'assets', 'audio'),
    join(dataDir, 'assets', 'video'),
    join(dataDir, 'jobs'),
    join(dataDir, 'logs'),
    // Scripts and working files produced by task runs, kept out of notes/
    // (FR-FILE-7, FR-CRON-8).
    join(dataDir, 'scripts')
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function loadConfig(): AppConfig {
  const dataDir = DEFAULTS.dataDir;
  seedDataDir(dataDir);
  ensureLayout(dataDir);

  let fileConfig: Partial<AppConfig> = {};
  const configPath = join(dataDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      // Fall back to defaults on a malformed config file.
    }
  }

  return {
    ...DEFAULTS,
    ...fileConfig,
    dataDir,
    ai: {
      type: fileConfig.ai?.type ?? DEFAULTS.ai.type,
      outputLanguage: fileConfig.ai?.outputLanguage ?? DEFAULTS.ai.outputLanguage,
      backends: { ...DEFAULT_BACKENDS, ...(fileConfig.ai?.backends ?? {}) },
      // Reliability limits: filled from defaults for configs written by an
      // earlier release (FR-INSTALL-5, FR-REL-1/3/5).
      timeoutMs: positive(fileConfig.ai?.timeoutMs, DEFAULTS.ai.timeoutMs),
      maxOutputBytes: positive(fileConfig.ai?.maxOutputBytes, DEFAULTS.ai.maxOutputBytes),
      maxConcurrentRuns: positive(fileConfig.ai?.maxConcurrentRuns, DEFAULTS.ai.maxConcurrentRuns)
    },
    logTarget: fileConfig.logTarget === 'stdout' ? 'stdout' : DEFAULTS.logTarget,
    logFile: fileConfig.logFile ?? join(dataDir, 'logs', 'mnemo.log')
  };
}

/**
 * Persist AI settings to data/config.json (FR-AI-2, FR-SETTINGS-3): the active
 * backend and/or per-backend settings. Returns the reloaded configuration.
 */
export function saveSettings(
  dataDir: string,
  patch: {
    type?: AiBackendType;
    outputLanguage?: string;
    backends?: Record<string, AiBackendSettings>;
    timeoutMs?: number;
  }
): AppConfig {
  const configPath = join(dataDir, 'config.json');
  let current: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      current = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      current = {};
    }
  }
  const ai = (current.ai as Partial<AiConfig>) ?? {};
  current.ai = {
    ...ai,
    type: patch.type ?? ai.type ?? DEFAULTS.ai.type,
    outputLanguage: patch.outputLanguage ?? ai.outputLanguage ?? DEFAULTS.ai.outputLanguage,
    backends: { ...(ai.backends ?? {}), ...(patch.backends ?? {}) },
    timeoutMs: positive(patch.timeoutMs ?? ai.timeoutMs, DEFAULTS.ai.timeoutMs)
  };
  writeFileSync(configPath, JSON.stringify(current, null, 2), 'utf8');
  return loadConfig();
}
