import type { NoteStore, Note } from '../storage/notes.js';
import type { SearchService } from '../search/index.js';
import type { AiProvider, ChatMessage } from './provider.js';
import { crawl } from './crawler.js';

export interface CollectParams {
  sources: string[];
  category?: string;
}

/** A scheduled task run: the AI agent executes `instruction` (FR-CRON-7). */
export interface TaskParams {
  instruction?: string;
  sources?: string[];
  category?: string;
  /** Title for the produced note (usually the job name). */
  title?: string;
}

export interface CollectOutcome {
  createdNotes: string[];
  errors: Array<{ url: string; message: string }>;
}

/**
 * Orchestrates crawl -> summarize -> persist as Markdown (FR-AGENT-1..4).
 * Collected notes are stored under the "collected" category and read in Notes
 * (the dedicated news-feed view was removed).
 */
export class Collector {
  constructor(
    private readonly notes: NoteStore,
    private readonly search: SearchService,
    private provider: AiProvider
  ) {}

  /** Swap the active AI backend (FR-AI-2). */
  setProvider(provider: AiProvider): void {
    this.provider = provider;
  }

  get providerType(): string {
    return this.provider.type;
  }

  /** The active backend, for callers that need it directly (e.g. FR-CHAT-9). */
  get aiProvider(): AiProvider {
    return this.provider;
  }

  /** Chat with the active AI agent; `signal` cancels the run (FR-CHAT, FR-CHAT-7). */
  chat(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    return this.provider.chat(messages, signal);
  }

  async collect(params: CollectParams, now: string): Promise<CollectOutcome> {
    const category = params.category ?? 'collected';
    const createdNotes: string[] = [];
    const errors: CollectOutcome['errors'] = [];

    for (const url of params.sources) {
      try {
        const page = await crawl(url);
        const { keypoints, summary } = await this.provider.summarize(page.title, page.text);
        const note = this.buildNote(page.url, page.title, keypoints, summary, category, now);
        const created = this.notes.create(note, now);
        createdNotes.push(created.id);
      } catch (err) {
        errors.push({ url, message: err instanceof Error ? err.message : String(err) });
      }
    }

    if (createdNotes.length) this.search.reindex();
    return { createdNotes, errors };
  }

  /**
   * Run a scheduled task: the AI agent executes the task instruction, optionally
   * using any listed sources as crawled context, and the result is saved as a
   * note (FR-CRON-7). With no instruction, falls back to plain collection.
   */
  async runTask(params: TaskParams, now: string): Promise<CollectOutcome> {
    const instruction = (params.instruction ?? '').trim();
    if (!instruction) {
      return this.collect({ sources: params.sources ?? [], category: params.category }, now);
    }

    const category = params.category ?? 'collected';
    const errors: CollectOutcome['errors'] = [];
    let context = '';
    for (const url of params.sources ?? []) {
      try {
        const page = await crawl(url);
        context += `\n\n# ${page.title} (${url})\n${page.text}`;
      } catch (err) {
        errors.push({ url, message: err instanceof Error ? err.message : String(err) });
      }
    }

    let createdNotes: string[] = [];
    try {
      const output = await this.provider.execute(instruction, context.trim());
      const title = params.title?.trim() || firstLine(instruction);
      const sources = params.sources ?? [];
      const body =
        `> AI task run on ${now}${sources.length ? ` · sources: ${sources.join(', ')}` : ''}\n\n` +
        `**Task:** ${instruction}\n\n---\n\n${output}\n`;
      const created = this.notes.create({ title, category, body } satisfies Partial<Note>, now);
      createdNotes = [created.id];
      this.search.reindex();
    } catch (err) {
      errors.push({ url: '(task)', message: err instanceof Error ? err.message : String(err) });
    }

    return { createdNotes, errors };
  }

  private buildNote(
    url: string,
    title: string,
    keypoints: string[],
    summary: string,
    category: string,
    now: string
  ): Parameters<NoteStore['create']>[0] {
    const bulletList = keypoints.map((k) => `- ${k}`).join('\n');
    // Provenance lives in the body: notes carry no frontmatter (FR-NOTE-5).
    const body =
      `> Collected from [${url}](${url}) on ${now}\n\n` +
      `## Key points\n\n${bulletList || '- (none extracted)'}\n\n` +
      `## Summary\n\n${summary}\n`;
    return { title, category, body } satisfies Partial<Note>;
  }
}

/** First non-empty line of the instruction, truncated, as a note title. */
function firstLine(instruction: string): string {
  const line = instruction.split('\n').map((l) => l.trim()).find(Boolean) ?? 'Task';
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}
