import FlexSearch from 'flexsearch';
import type { NoteStore, NoteMeta } from '../storage/notes.js';

interface IndexedDoc {
  id: string;
  title: string;
  body: string;
}

/** Notes indexed between two yields to the event loop. */
const BATCH = 50;

/**
 * How much of a note's body is indexed. Indexing is one synchronous call per
 * note, so a single very large note blocks the event loop no matter how the
 * loop yields: a 2.9 MB note in the test corpus stalled the server for ~3 s.
 * Capping bounds that stall and the index's memory; only the tail of a handful
 * of unusually large notes falls outside search (11 of 1,433 here).
 */
const MAX_INDEXED_CHARS = 200_000;

/**
 * In-process full-text search over notes (FR-AGENT-5).
 *
 * The index is built **in the background, in batches**: with a real corpus
 * (1,433 notes / 15 MB) a single synchronous build takes ~12 s, and doing that
 * in the constructor blocked startup and the event loop with it — the server
 * answered nothing until it finished (the failure mode FR-REL-4 exists to
 * prevent). Searches run against whatever is indexed so far and `ready`
 * reports whether the build has finished.
 */
export class SearchService {
  private index = SearchService.newIndex();
  private building = false;
  /** A write arrived while a build was running; rebuild once it ends. */
  private dirty = false;
  private built = false;

  constructor(private readonly notes: NoteStore) {
    void this.rebuild();
  }

  /** False while the initial (or a queued) build is still running. */
  get ready(): boolean {
    return this.built && !this.building;
  }

  private static newIndex(): FlexSearch.Document<IndexedDoc, false> {
    return new FlexSearch.Document<IndexedDoc, false>({
      document: {
        id: 'id',
        index: ['title', 'body']
        // No `store`: search() reads the note back from disk, so keeping a
        // second copy of every document in memory bought nothing and cost
        // gigabytes on a large corpus.
      },
      tokenize: 'forward'
    });
  }

  /** Rebuild the whole index without blocking the event loop. */
  async rebuild(): Promise<void> {
    if (this.building) {
      this.dirty = true;
      return;
    }
    this.building = true;
    try {
      do {
        this.dirty = false;
        const next = SearchService.newIndex();
        let n = 0;
        for (const meta of this.notes.list()) {
          const full = this.notes.get(meta.id);
          // The title is the file name (FR-NOTE-7); notes carry no tags.
          if (full) {
            next.add({
              id: full.id,
              title: full.title,
              body: full.body.slice(0, MAX_INDEXED_CHARS)
            });
          }
          if (++n % BATCH === 0) await new Promise((r) => setImmediate(r));
        }
        this.index = next;
        this.built = true;
      } while (this.dirty);
    } finally {
      this.building = false;
    }
  }

  /**
   * Reflect a single note write immediately. A full rebuild takes seconds, so
   * doing one per save would leave a just-saved note unsearchable until it
   * finished; adding the one document keeps the index current at once
   * (FlexSearch replaces a document with the same id).
   */
  upsert(id: string): void {
    const note = this.notes.get(id);
    if (!note) {
      this.remove(id);
      return;
    }
    this.index.add({
      id: note.id,
      title: note.title,
      body: note.body.slice(0, MAX_INDEXED_CHARS)
    });
    // A rebuild in flight will swap in an index built from an older listing and
    // drop this addition, so ask it to run once more when it finishes.
    if (this.building) this.dirty = true;
  }

  /** Drop a deleted (or renamed-away) note from the index. */
  remove(id: string): void {
    try {
      this.index.remove(id);
    } catch {
      // Not indexed yet — nothing to drop.
    }
    if (this.building) this.dirty = true;
  }

  /** Full rebuild, e.g. after a collection run touched many notes. */
  reindex(): void {
    void this.rebuild();
  }

  search(query: string, limit = 30): NoteMeta[] {
    if (!query.trim()) return [];
    const results = this.index.search(query, { limit });
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const field of results) {
      for (const item of field.result) {
        const id = String(item);
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }
    const metas: NoteMeta[] = [];
    for (const id of ids) {
      const note = this.notes.get(id);
      if (note) {
        const { body, ...meta } = note;
        void body;
        metas.push(meta);
      }
    }
    return metas;
  }
}
