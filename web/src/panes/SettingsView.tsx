import { useEffect, useState } from 'react';
import { api, type AiBackendSettings, type AiConfig } from '../api.js';

const LABELS: Record<string, string> = {
  'agent-cli': 'agent-cli',
  'claude-code': 'Claude Code (CLI)',
  local: 'Local (offline heuristic)'
};

const LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語 (Japanese)' },
  { code: 'zh', label: '中文 (Chinese)' },
  { code: 'ko', label: '한국어 (Korean)' },
  { code: 'es', label: 'Español (Spanish)' },
  { code: 'fr', label: 'Français (French)' },
  { code: 'de', label: 'Deutsch (German)' }
];

/** Which settings fields are relevant to each backend. */
const FIELDS: Record<string, Array<keyof AiBackendSettings>> = {
  'agent-cli': ['command', 'args', 'model'],
  'claude-code': ['command', 'args', 'model'],
  local: []
};

/** Detailed AI agent configuration page (FR-SETTINGS-1..3). */
export function SettingsView() {
  const [backends, setBackends] = useState<string[]>([]);
  const [ai, setAi] = useState<AiConfig | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    api.settings().then((r) => {
      setBackends(r.backends);
      setAi(r.ai);
    });
  }, []);

  if (!ai) return <div className="p-6 text-sm text-gray-400">Loading…</div>;

  const selected = ai.type;
  const settings = ai.backends[selected] ?? {};

  function patchField(field: keyof AiBackendSettings, raw: string) {
    if (!ai) return;
    const value: AiBackendSettings[keyof AiBackendSettings] =
      field === 'args' ? raw.split(/\s+/).filter(Boolean) : raw;
    setAi({
      ...ai,
      backends: { ...ai.backends, [selected]: { ...settings, [field]: value } }
    });
  }

  async function save() {
    if (!ai) return;
    setStatus('Saving…');
    const r = await api.updateSettings({
      type: ai.type,
      outputLanguage: ai.outputLanguage,
      backends: ai.backends
    });
    setAi(r.ai);
    setStatus(`Saved — active backend: ${r.selected}`);
  }

  return (
    <div className="h-full overflow-auto p-6">
      <h1 className="mb-1 text-2xl font-bold">Settings</h1>
      <p className="mb-6 text-sm text-gray-500">Configure the AI agent used for information collection.</p>

      <section className="max-w-xl space-y-5">
        <div>
          <label className="mb-1 block text-sm font-medium">Active AI backend</label>
          <select
            className="w-full rounded border border-border bg-white px-2 py-1.5 text-sm outline-none"
            value={selected}
            onChange={(e) => setAi({ ...ai, type: e.target.value })}
          >
            {backends.map((b) => (
              <option key={b} value={b}>
                {LABELS[b] ?? b}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-gray-400">
            The Claude API is not used; “Claude Code” runs via its CLI.
          </p>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium">AI output language</label>
          <select
            className="w-full rounded border border-border bg-white px-2 py-1.5 text-sm outline-none"
            value={ai.outputLanguage}
            onChange={(e) => setAi({ ...ai, outputLanguage: e.target.value })}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-gray-400">
            Language used for AI-generated summaries and chat replies.
          </p>
        </div>

        {FIELDS[selected]?.length ? (
          <div className="rounded-lg border border-border p-4">
            <h2 className="mb-3 text-sm font-semibold">{LABELS[selected] ?? selected} settings</h2>
            <div className="space-y-3">
              {FIELDS[selected].map((field) => (
                <div key={field}>
                  <label className="mb-1 block text-xs font-medium capitalize text-gray-600">
                    {field}
                  </label>
                  <input
                    className="w-full rounded border border-border px-2 py-1 text-sm outline-none"
                    value={
                      field === 'args'
                        ? (settings.args ?? []).join(' ')
                        : ((settings[field] as string | null | undefined) ?? '')
                    }
                    placeholder={placeholder(field)}
                    onChange={(e) => patchField(field, e.target.value)}
                  />
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-400">This backend has no configurable settings.</p>
        )}

        <div className="flex items-center gap-3">
          <button
            className="rounded bg-accent px-4 py-1.5 text-sm font-medium text-white"
            onClick={save}
          >
            Save settings
          </button>
          <span className="text-xs text-gray-500">{status}</span>
        </div>
      </section>
    </div>
  );
}

function placeholder(field: keyof AiBackendSettings): string {
  switch (field) {
    case 'command':
      return 'e.g. agent-cli';
    case 'args':
      return 'space-separated, e.g. run --auto-approve-tools';
    case 'model':
      return 'optional model override';
    default:
      return '';
  }
}
