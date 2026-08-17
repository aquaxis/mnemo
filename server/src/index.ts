import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';

import {
  loadConfig,
  saveSettings,
  AI_BACKENDS,
  type AiBackendType,
  type AiBackendSettings,
  WEB_DIST_DIR
} from './config.js';
import { NoteStore } from './storage/notes.js';
import { AssetStore } from './storage/assets.js';
import { SearchService } from './search/index.js';
import { createProvider, type ChatMessage } from './agent/provider.js';
import { Collector } from './agent/collector.js';
import { Scheduler } from './scheduler/scheduler.js';

let config = loadConfig();

// The notes directory is given to the CLI agents as their working directory so
// they can search/read the full note corpus (FR-FILE-6).
const notesDir = join(config.dataDir, 'notes');

const notes = new NoteStore(config.dataDir);
const assets = new AssetStore(config.dataDir);
const search = new SearchService(notes);
const provider = createProvider(config.ai, notesDir);
const collector = new Collector(notes, search, provider);
const scheduler = new Scheduler(config.dataDir, collector);

const app = Fastify({ logger: true });
await app.register(fastifyMultipart);

// --- Serve binary assets and (in production) the built web app --------------
await app.register(fastifyStatic, {
  root: join(config.dataDir, 'assets'),
  prefix: '/assets/'
});
if (existsSync(WEB_DIST_DIR)) {
  await app.register(fastifyStatic, {
    root: WEB_DIST_DIR,
    prefix: '/',
    decorateReply: false
  });
}

const now = () => new Date().toISOString();

// --- Categories -------------------------------------------------------------
app.get('/api/categories', async () => ({ categories: notes.listCategories() }));
app.post<{ Body: { name: string } }>('/api/categories', async (req) => {
  notes.createCategory(req.body.name);
  return { categories: notes.listCategories() };
});

// --- Notes ------------------------------------------------------------------
app.get<{ Querystring: { category?: string } }>('/api/notes', async (req) => ({
  notes: notes.list(req.query.category)
}));
app.get<{ Params: { id: string } }>('/api/notes/:id', async (req, reply) => {
  const note = notes.get(req.params.id);
  if (!note) return reply.code(404).send({ error: 'Not found' });
  return note;
});
app.post('/api/notes', async (req) => {
  const note = notes.create(req.body as Record<string, unknown>, now());
  search.reindex();
  return note;
});
app.put<{ Params: { id: string } }>('/api/notes/:id', async (req, reply) => {
  const note = notes.update(req.params.id, req.body as Record<string, unknown>, now());
  if (!note) return reply.code(404).send({ error: 'Not found' });
  search.reindex();
  return note;
});
app.delete<{ Params: { id: string } }>('/api/notes/:id', async (req, reply) => {
  const ok = notes.delete(req.params.id);
  if (!ok) return reply.code(404).send({ error: 'Not found' });
  search.reindex();
  return { deleted: true };
});

// --- Search -----------------------------------------------------------------
app.get<{ Querystring: { q?: string } }>('/api/search', async (req) => ({
  notes: search.search(req.query.q ?? '')
}));

// --- Assets -----------------------------------------------------------------
app.post('/api/assets', async (req, reply) => {
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: 'No file' });
  const buffer = await file.toBuffer();
  return assets.save(file.filename, buffer);
});

// --- Agent on-demand collection ---------------------------------------------
app.post<{ Body: { sources: string[]; category?: string } }>('/api/agent/collect', async (req) => {
  return collector.collect(
    { sources: req.body.sources ?? [], category: req.body.category },
    now()
  );
});

// --- AI agent chat (FR-CHAT) ------------------------------------------------
app.post<{ Body: { messages: ChatMessage[] } }>('/api/chat', async (req) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const reply = await collector.chat(messages);
  return { reply };
});

// Persist a conversation as a Markdown note under the `chats` category (FR-CHAT-4).
app.post<{ Body: { messages: ChatMessage[]; id?: string; title?: string } }>(
  '/api/chat/save',
  async (req, reply) => {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!messages.length) return reply.code(400).send({ error: 'No messages' });
    const firstUser = messages.find((m) => m.role === 'user')?.content ?? 'Chat';
    const title = req.body.title?.trim() || firstUser.split('\n')[0].slice(0, 60);
    const body = messages
      .map((m) => `**${m.role === 'user' ? 'You' : 'AI'}:**\n\n${m.content}`)
      .join('\n\n---\n\n');
    const input = { title, category: 'chats', tags: ['chat'], type: 'note' as const, body };
    const note = req.body.id
      ? notes.update(req.body.id, input, now())
      : notes.create(input, now());
    search.reindex();
    return note;
  }
);

// --- AI backend selection (FR-AI-1, FR-AI-2) --------------------------------
app.get('/api/ai/backends', async () => ({
  backends: AI_BACKENDS,
  selected: collector.providerType
}));
app.put<{ Body: { type: AiBackendType } }>('/api/ai/backend', async (req, reply) => {
  const type = req.body?.type;
  if (!type || !AI_BACKENDS.includes(type)) {
    return reply.code(400).send({ error: 'Unknown backend', backends: AI_BACKENDS });
  }
  config = saveSettings(config.dataDir, { type });
  collector.setProvider(createProvider(config.ai, notesDir));
  return { selected: collector.providerType };
});

// --- Settings page (FR-SETTINGS-1..3) ---------------------------------------
app.get('/api/settings', async () => ({
  backends: AI_BACKENDS,
  ai: config.ai,
  port: config.port
}));
app.put<{
  Body: {
    type?: AiBackendType;
    outputLanguage?: string;
    backends?: Record<string, AiBackendSettings>;
  };
}>('/api/settings', async (req, reply) => {
  const { type, outputLanguage, backends } = req.body ?? {};
  if (type && !AI_BACKENDS.includes(type)) {
    return reply.code(400).send({ error: 'Unknown backend', backends: AI_BACKENDS });
  }
  config = saveSettings(config.dataDir, { type, outputLanguage, backends });
  collector.setProvider(createProvider(config.ai, notesDir));
  return { ai: config.ai, selected: collector.providerType };
});

// --- Scheduled jobs ---------------------------------------------------------
app.get('/api/jobs', async () => ({ jobs: scheduler.list() }));
app.post('/api/jobs', async (req) => scheduler.create(req.body as never));
app.put<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
  const job = scheduler.update(req.params.id, req.body as never);
  if (!job) return reply.code(404).send({ error: 'Not found' });
  return job;
});
app.delete<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
  const ok = scheduler.delete(req.params.id);
  if (!ok) return reply.code(404).send({ error: 'Not found' });
  return { deleted: true };
});
app.get<{ Params: { id: string } }>('/api/jobs/:id/runs', async (req) => ({
  runs: scheduler.runsFor(req.params.id)
}));
app.post<{ Params: { id: string } }>('/api/jobs/:id/run', async (req, reply) => {
  const run = await scheduler.run(req.params.id);
  if (!run) return reply.code(404).send({ error: 'Not found' });
  return run;
});

// --- SPA fallback -----------------------------------------------------------
const indexHtmlPath = join(WEB_DIST_DIR, 'index.html');
app.setNotFoundHandler((req, reply) => {
  if (req.raw.url?.startsWith('/api/')) {
    return reply.code(404).send({ error: 'Not found' });
  }
  // Serve the SPA shell for non-API routes. Read the file directly rather than
  // reply.sendFile, whose root is bound to the first static plugin (data/assets).
  if (existsSync(indexHtmlPath)) {
    return reply.type('text/html').send(readFileSync(indexHtmlPath));
  }
  return reply.code(404).send({ error: 'Web app not built. Run "npm run build".' });
});

scheduler.start();

app.listen({ port: config.port, host: '0.0.0.0' }).then(() => {
  app.log.info(`Mnemo running on http://localhost:${config.port} (data: ${config.dataDir})`);
});
