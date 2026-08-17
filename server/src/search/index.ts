import FlexSearch from 'flexsearch';
import type { NoteStore, NoteMeta } from '../storage/notes.js';

interface IndexedDoc {
  id: string;
  title: string;
  tags: string;
  body: string;
}

/**
 * In-process full-text search over notes (FR-AGENT-5). Rebuilt on demand and
 * refreshed after note writes / agent collection runs.
 */
export class SearchService {
  private index: FlexSearch.Document<IndexedDoc, true>;

  constructor(private readonly notes: NoteStore) {
    this.index = this.buildIndex();
  }

  private buildIndex(): FlexSearch.Document<IndexedDoc, true> {
    const index = new FlexSearch.Document<IndexedDoc, true>({
      document: {
        id: 'id',
        index: ['title', 'tags', 'body'],
        store: true
      },
      tokenize: 'forward'
    });
    for (const note of this.notes.list()) {
      const full = this.notes.get(note.id);
      if (!full) continue;
      index.add({
        id: full.id,
        title: full.title,
        tags: full.tags.join(' '),
        body: full.body
      });
    }
    return index;
  }

  reindex(): void {
    this.index = this.buildIndex();
  }

  search(query: string, limit = 30): NoteMeta[] {
    if (!query.trim()) return [];
    const results = this.index.search(query, { limit, enrich: true });
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const field of results) {
      for (const item of field.result) {
        // With enrich:true each item is { id, doc }; otherwise it is a raw id.
        const id = String(typeof item === 'object' && item ? (item as { id: unknown }).id : item);
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
