import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import matter from 'gray-matter';

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

export interface NoteInput {
  title?: string;
  category?: string;
  tags?: string[];
  source?: string | null;
  type?: 'note' | 'collected';
  body?: string;
}

/** Filesystem-backed note store. All notes are Markdown files with frontmatter. */
export class NoteStore {
  private readonly notesDir: string;

  constructor(dataDir: string) {
    this.notesDir = join(dataDir, 'notes');
    mkdirSync(this.notesDir, { recursive: true });
  }

  private categoryDir(category: string): string {
    const safe = sanitizeCategory(category) || 'inbox';
    return join(this.notesDir, ...safe.split('/'));
  }

  private filePath(category: string, id: string): string {
    return join(this.categoryDir(category), `${id}.md`);
  }

  /** All category folders as relative paths, nested folders included (FR-FILE-5). */
  listCategories(): string[] {
    if (!existsSync(this.notesDir)) return [];
    const out: string[] = [];
    const walk = (absDir: string, rel: string): void => {
      for (const name of readdirSync(absDir)) {
        const abs = join(absDir, name);
        if (statSync(abs).isDirectory()) {
          const relPath = rel ? `${rel}/${name}` : name;
          out.push(relPath);
          walk(abs, relPath);
        }
      }
    };
    walk(this.notesDir, '');
    return out.sort();
  }

  createCategory(category: string): void {
    mkdirSync(this.categoryDir(category), { recursive: true });
  }

  /** List note metadata, optionally filtered by category. */
  list(category?: string): NoteMeta[] {
    const categories = category ? [category] : this.listCategories();
    const notes: NoteMeta[] = [];
    for (const cat of categories) {
      const dir = this.categoryDir(cat);
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.md')) continue;
        const parsed = this.readFile(join(dir, file), cat);
        if (parsed) {
          const { body, ...meta } = parsed;
          void body;
          notes.push(meta);
        }
      }
    }
    return notes.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  private readFile(path: string, category: string): Note | null {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    const { data, content } = matter(raw);
    // The note id is the file's basename: Mnemo locates notes by
    // `<category>/<id>.md`, so the id MUST equal the filename. Ignoring a
    // frontmatter `id` that disagrees keeps externally-created files openable.
    const id = basename(path, '.md');
    return {
      id,
      title: String(data.title ?? 'Untitled'),
      // Category is the note's actual folder path (authoritative over frontmatter),
      // so nested folders and moved files are always reported correctly.
      category,
      tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
      source: data.source ? String(data.source) : null,
      type: data.type === 'collected' ? 'collected' : 'note',
      created: toIso(data.created),
      updated: toIso(data.updated),
      body: content.trimStart()
    };
  }

  /** Locate a note by id across all categories. */
  get(id: string): Note | null {
    for (const cat of this.listCategories()) {
      const path = this.filePath(cat, id);
      if (existsSync(path)) return this.readFile(path, cat);
    }
    return null;
  }

  create(input: NoteInput, now: string): Note {
    const id = randomUUID();
    const category = sanitizeCategory(input.category ?? 'inbox') || 'inbox';
    this.createCategory(category);
    const note: Note = {
      id,
      title: input.title ?? 'Untitled',
      category,
      tags: input.tags ?? [],
      source: input.source ?? null,
      type: input.type ?? 'note',
      created: now,
      updated: now,
      body: input.body ?? ''
    };
    this.write(note);
    return note;
  }

  update(id: string, input: NoteInput, now: string): Note | null {
    const existing = this.get(id);
    if (!existing) return null;
    const nextCategory =
      input.category !== undefined
        ? sanitizeCategory(input.category) || 'inbox'
        : existing.category;
    // If the category changed, remove the old file.
    if (nextCategory !== existing.category) {
      const oldPath = this.filePath(existing.category, id);
      if (existsSync(oldPath)) rmSync(oldPath);
      this.createCategory(nextCategory);
    }
    const note: Note = {
      ...existing,
      title: input.title ?? existing.title,
      category: nextCategory,
      tags: input.tags ?? existing.tags,
      source: input.source === undefined ? existing.source : input.source,
      type: input.type ?? existing.type,
      body: input.body === undefined ? existing.body : input.body,
      updated: now
    };
    this.write(note);
    return note;
  }

  delete(id: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    const path = this.filePath(existing.category, id);
    if (existsSync(path)) rmSync(path);
    return true;
  }

  private write(note: Note): void {
    const { body, ...meta } = note;
    const file = matter.stringify(body ? `${body}\n` : '', meta);
    mkdirSync(this.categoryDir(note.category), { recursive: true });
    writeFileSync(this.filePath(note.category, note.id), file, 'utf8');
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Sanitize a (possibly nested) category path: sanitize each `/`-separated
 * segment and keep the separators, dropping empty / traversal segments so a
 * category like `wiki/subtopic` maps to nested folders under `notes/`.
 */
function sanitizeCategory(category: string): string {
  return category
    .split('/')
    .map((seg) => sanitizeSegment(seg))
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

/** Normalize a frontmatter date (YAML may parse it into a Date) to ISO-8601. */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date(0).toISOString();
}
