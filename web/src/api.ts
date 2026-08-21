/**
 * Notes are plain Markdown; this metadata is derived from the file itself —
 * `title` is the file name (FR-NOTE-7) and `updated` its modification time
 * (FR-NOTE-8).
 */
export interface NoteMeta {
  id: string;
  title: string;
  category: string;
  created: string;
  updated: string;
}

export interface Note extends NoteMeta {
  body: string;
}

export interface Job {
  id: string;
  name: string;
  cron: string;
  action: 'collect';
  params: { instruction?: string; sources: string[]; category?: string };
  enabled: boolean;
}

export interface JobRun {
  jobId: string;
  startedAt: string;
  finishedAt: string;
  status: 'success' | 'error';
  createdNotes: string[];
  message: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiBackendSettings {
  command?: string;
  args?: string[];
  model?: string | null;
}

export interface AiConfig {
  type: string;
  outputLanguage: string;
  backends: Record<string, AiBackendSettings>;
  /** Hard limit for one AI backend invocation, in ms (FR-REL-1). */
  timeoutMs: number;
  maxOutputBytes: number;
  maxConcurrentRuns: number;
}

export interface SettingsResponse {
  backends: string[];
  ai: AiConfig;
  port: number;
  /** Whether each backend's command was found on PATH (FR-REL-6). */
  available: Record<string, boolean>;
  /** Where the server writes its log, or null when it logs to the console. */
  logFile: string | null;
}

/**
 * Resolve a JSON response, preserving the server's error text so backend
 * failures are shown to the user instead of a generic message (FR-REL-6).
 */
async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: string };
      detail = body?.error ?? '';
    } catch {
      // Non-JSON error body; fall back to the status text.
    }
    throw new Error(detail || `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  categories: () => fetch('/api/categories').then(json<{ categories: string[] }>),
  createCategory: (name: string) =>
    fetch('/api/categories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name })
    }).then(json<{ categories: string[] }>),

  notes: (category?: string) =>
    fetch(`/api/notes${category ? `?category=${encodeURIComponent(category)}` : ''}`).then(
      json<{ notes: NoteMeta[] }>
    ),
  note: (id: string) => fetch(`/api/notes/${id}`).then(json<Note>),
  createNote: (input: Partial<Note>) =>
    fetch('/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input)
    }).then(json<Note>),
  updateNote: (id: string, input: Partial<Note>) =>
    fetch(`/api/notes/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input)
    }).then(json<Note>),
  deleteNote: (id: string) => fetch(`/api/notes/${id}`, { method: 'DELETE' }).then(json),

  search: (q: string) =>
    fetch(`/api/search?q=${encodeURIComponent(q)}`).then(json<{ notes: NoteMeta[] }>),

  chat: (messages: ChatMessage[], signal?: AbortSignal) =>
    fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages }),
      signal
    }).then(
      json<{
        reply: string;
        /** Set when the message asked for a recurring task (FR-CHAT-9). */
        scheduled?: { id: string; name: string; cron: string; instruction: string };
        scheduleError?: string;
      }>
    ),
  saveChat: (messages: ChatMessage[], id?: string) =>
    fetch('/api/chat/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages, id })
    }).then(json<Note>),
  collect: (sources: string[], category?: string) =>
    fetch('/api/agent/collect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sources, category })
    }).then(json<{ createdNotes: string[]; errors: Array<{ url: string; message: string }> }>),

  aiBackends: () =>
    fetch('/api/ai/backends').then(
      json<{ backends: string[]; selected: string; available: Record<string, boolean> }>
    ),
  selectAiBackend: (type: string) =>
    fetch('/api/ai/backend', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type })
    }).then(json<{ selected: string }>),

  settings: () => fetch('/api/settings').then(json<SettingsResponse>),
  /** Read-only; kept off /api/settings, whose payload the UI writes back. */
  version: () => fetch('/api/version').then(json<{ version: string }>),
  updateSettings: (patch: {
    type?: string;
    outputLanguage?: string;
    backends?: Record<string, AiBackendSettings>;
    timeoutMs?: number;
  }) =>
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch)
    }).then(json<{ ai: AiConfig; selected: string; available: Record<string, boolean> }>),

  jobs: () => fetch('/api/jobs').then(json<{ jobs: Job[] }>),
  createJob: (job: Omit<Job, 'id'>) =>
    fetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(job)
    }).then(json<Job>),
  updateJob: (id: string, patch: Partial<Job>) =>
    fetch(`/api/jobs/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch)
    }).then(json<Job>),
  deleteJob: (id: string) => fetch(`/api/jobs/${id}`, { method: 'DELETE' }).then(json),
  runJob: (id: string) => fetch(`/api/jobs/${id}/run`, { method: 'POST' }).then(json<JobRun>),
  jobRuns: (id: string) => fetch(`/api/jobs/${id}/runs`).then(json<{ runs: JobRun[] }>)
};
