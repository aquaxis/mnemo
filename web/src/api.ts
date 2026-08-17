export interface NoteMeta {
  id: string;
  title: string;
  category: string;
  tags: string[];
  source: string | null;
  type: 'note' | 'collected';
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
}

export interface SettingsResponse {
  backends: string[];
  ai: AiConfig;
  port: number;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
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

  chat: (messages: ChatMessage[]) =>
    fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages })
    }).then(json<{ reply: string }>),
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
    fetch('/api/ai/backends').then(json<{ backends: string[]; selected: string }>),
  selectAiBackend: (type: string) =>
    fetch('/api/ai/backend', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type })
    }).then(json<{ selected: string }>),

  settings: () => fetch('/api/settings').then(json<SettingsResponse>),
  updateSettings: (patch: {
    type?: string;
    outputLanguage?: string;
    backends?: Record<string, AiBackendSettings>;
  }) =>
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch)
    }).then(json<{ ai: AiConfig; selected: string }>),

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
