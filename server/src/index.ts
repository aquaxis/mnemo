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
import { createLogStream } from './log.js';
import { NoteStore } from './storage/notes.js';
import { AssetStore } from './storage/assets.js';
import { SearchService } from './search/index.js';
import {
  backendAvailable,
  createProvider,
  setProviderLogger,
  type ChatMessage
} from './agent/provider.js';
import { Collector } from './agent/collector.js';
import { proposeJob } from './agent/task-proposal.js';
import { Scheduler } from './scheduler/scheduler.js';

let config = loadConfig();

// CLI agents are spawned in the data root, not in notes/: from here they read
// notes/ to search the whole corpus (FR-FILE-6), while any file they create
// belongs in scripts/ rather than among the Markdown knowledge (FR-FILE-7,
// FR-CRON-8).
const agentWorkDir = config.dataDir;

const notes = new NoteStore(config.dataDir);
const assets = new AssetStore(config.dataDir);
const search = new SearchService(notes);
const provider = createProvider(config.ai, agentWorkDir);
const collector = new Collector(notes, search, provider);
const scheduler = new Scheduler(config.dataDir, collector);

// Log to a file by default: writing to an inherited terminal or pipe is
// synchronous on POSIX, so a closed/stalled terminal would block the event loop
// and take the whole server down (FR-REL-4, NFR-7). See log.ts.
const app = Fastify({ logger: { stream: createLogStream(config) } });
setProviderLogger((message, detail) => app.log.warn(detail, message));

// A dead stdout/stderr (closed terminal) must not raise an uncaught error.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});

// The server keeps serving through unexpected faults; a single bad request or a
// misbehaving AI backend may not end the process (FR-REL-4).
process.on('uncaughtException', (err) => {
  app.log.error({ err: serializeError(err) }, 'Uncaught exception (server kept running)');
});
process.on('unhandledRejection', (reason) => {
  app.log.error({ err: serializeError(reason) }, 'Unhandled rejection (server kept running)');
});

// Any route that throws returns JSON instead of leaving the client waiting.
app.setErrorHandler((err, _req, reply) => {
  app.log.error({ err: serializeError(err) }, 'Request failed');
  reply.code(err.statusCode && err.statusCode >= 400 ? err.statusCode : 500).send({
    error: err.message || 'Internal server error'
  });
});

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

function serializeError(err: unknown): { message: string; stack?: string } {
  return err instanceof Error
    ? { message: err.message, stack: err.stack }
    : { message: String(err) };
}

/** Availability of each selectable backend's command on PATH (FR-REL-6). */
const backendAvailability = () =>
  Object.fromEntries(AI_BACKENDS.map((b) => [b, backendAvailable(config.ai, b)]));

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
app.post<{ Body: { messages: ChatMessage[] } }>('/api/chat', async (req, reply) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  // Cancelling in the UI (or closing the tab) drops the connection before the
  // response is written; stop the agent run instead of letting it hold a
  // concurrency slot (FR-CHAT-7). Watch the *response* stream: the request
  // stream also emits "close" once its body has been read, which would abort
  // every normal chat.
  const controller = new AbortController();
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) controller.abort();
  });

  // If the message asks for a recurring task, register it in the scheduler and
  // tell the user what was created (FR-CHAT-9). The analysis runs *alongside*
  // the reply — in sequence the two agent runs would add up and could approach
  // the timeout — and it never blocks the answer: a failure to analyze or
  // register is reported next to the reply, which still goes back.
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const proposalPromise = lastUser
    ? proposeJob(collector.aiProvider, lastUser, controller.signal)
    : Promise.resolve(null);
  // Attach a catch immediately so a rejection can never become unhandled while
  // the reply is still being awaited.
  const proposalSettled = proposalPromise.then(
    (p) => ({ proposal: p, error: null as string | null }),
    (err: unknown) => ({
      proposal: null,
      error: err instanceof Error ? err.message : String(err)
    })
  );

  const text = await collector.chat(messages, controller.signal);
  const { proposal, error } = await proposalSettled;

  let scheduled: { id: string; name: string; cron: string; instruction: string } | undefined;
  let scheduleError: string | undefined = error ?? undefined;
  if (proposal && !controller.signal.aborted) {
    try {
      const job = scheduler.create({
        name: proposal.name,
        cron: proposal.cron,
        action: 'collect',
        params: { instruction: proposal.instruction, sources: [], category: proposal.category },
        enabled: true
      });
      scheduled = {
        id: job.id,
        name: job.name,
        cron: job.cron,
        instruction: job.params.instruction ?? ''
      };
      app.log.info({ jobId: job.id, cron: job.cron }, 'Registered a task from chat');
    } catch (err) {
      scheduleError = err instanceof Error ? err.message : String(err);
    }
  }
  if (scheduleError) {
    app.log.warn({ error: scheduleError }, 'Could not register a task from chat');
  }

  return { reply: text, scheduled, scheduleError };
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
  selected: collector.providerType,
  available: backendAvailability()
}));
app.put<{ Body: { type: AiBackendType } }>('/api/ai/backend', async (req, reply) => {
  const type = req.body?.type;
  if (!type || !AI_BACKENDS.includes(type)) {
    return reply.code(400).send({ error: 'Unknown backend', backends: AI_BACKENDS });
  }
  config = saveSettings(config.dataDir, { type });
  collector.setProvider(createProvider(config.ai, agentWorkDir));
  return { selected: collector.providerType };
});

// --- Settings page (FR-SETTINGS-1..3) ---------------------------------------
app.get('/api/settings', async () => ({
  backends: AI_BACKENDS,
  ai: config.ai,
  port: config.port,
  available: backendAvailability(),
  logFile: config.logTarget === 'file' ? config.logFile : null
}));
app.put<{
  Body: {
    type?: AiBackendType;
    outputLanguage?: string;
    backends?: Record<string, AiBackendSettings>;
    timeoutMs?: number;
  };
}>('/api/settings', async (req, reply) => {
  const { type, outputLanguage, backends, timeoutMs } = req.body ?? {};
  if (type && !AI_BACKENDS.includes(type)) {
    return reply.code(400).send({ error: 'Unknown backend', backends: AI_BACKENDS });
  }
  config = saveSettings(config.dataDir, { type, outputLanguage, backends, timeoutMs });
  collector.setProvider(createProvider(config.ai, agentWorkDir));
  return { ai: config.ai, selected: collector.providerType, available: backendAvailability() };
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
  const url = `http://localhost:${config.port}`;
  app.log.info(`Mnemo running on ${url} (data: ${config.dataDir})`);
  if (!backendAvailable(config.ai, config.ai.type)) {
    app.log.warn(
      { backend: config.ai.type, command: config.ai.backends[config.ai.type]?.command },
      'The configured AI backend command was not found on PATH; chat and agent tasks will report it'
    );
  }
  // One console line so the terminal still shows where Mnemo is; guarded, since
  // the terminal may already be gone (FR-REL-4).
  try {
    process.stdout.write(
      `Mnemo running on ${url}\n  data: ${config.dataDir}\n` +
        (config.logTarget === 'file' ? `  log:  ${config.logFile}\n` : '')
    );
  } catch {
    // Never let a dead terminal affect startup.
  }
}).catch((err: NodeJS.ErrnoException) => {
  // Startup failures must be visible on the console too: with the log going to
  // a file, an unreported failure would look like the server exiting silently.
  app.log.error({ err: serializeError(err) }, 'Mnemo failed to start');
  const hint =
    err.code === 'EADDRINUSE'
      ? `Port ${config.port} is already in use — another Mnemo instance is probably still running.\n` +
        `Find it with:  ss -ltnp | grep :${config.port}\n` +
        `Stop it with:  kill -9 <pid>   (a frozen process ignores a plain kill)\n`
      : '';
  try {
    process.stderr.write(`Mnemo failed to start: ${err.message}\n${hint}`);
  } catch {
    // The terminal may be gone; the log file has the details either way.
  }
  process.exit(1);
});
