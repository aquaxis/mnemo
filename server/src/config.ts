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
}

export interface AppConfig {
  port: number;
  dataDir: string;
  ai: AiConfig;
}

const DEFAULT_BACKENDS: Record<string, AiBackendSettings> = {
  'agent-cli': { command: 'agent-cli', args: ['run', '--auto-approve-tools'], model: null },
  'claude-code': { command: 'claude', args: ['-p'], model: null },
  local: {}
};

// Shipped defaults: agent-cli backend and Japanese output (FR-SETTINGS-5).
// agent-cli uses its own configured provider (e.g. ollama glm-5.1:cloud).
const DEFAULTS: AppConfig = {
  port: Number(process.env.MNEMO_PORT ?? 3000),
  dataDir: process.env.MNEMO_DATA_DIR ?? join(ROOT_DIR, 'data'),
  ai: {
    type: (process.env.MNEMO_AI_TYPE as AiBackendType) ?? 'agent-cli',
    outputLanguage: process.env.MNEMO_AI_LANG ?? 'ja',
    backends: DEFAULT_BACKENDS
  }
};

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
    join(dataDir, 'jobs')
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
      backends: { ...DEFAULT_BACKENDS, ...(fileConfig.ai?.backends ?? {}) }
    }
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
    backends: { ...(ai.backends ?? {}), ...(patch.backends ?? {}) }
  };
  writeFileSync(configPath, JSON.stringify(current, null, 2), 'utf8');
  return loadConfig();
}
