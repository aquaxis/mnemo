import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs';
import { join, basename } from 'node:path';

/**
 * Note metadata. None of it is stored inside the file: a note is plain Markdown
 * (FR-NOTE-5) and every field below is derived from the file itself —
 * name, folder and timestamps (FR-NOTE-7, FR-NOTE-8).
 */
export interface NoteMeta {
  /** File basename without `.md`; also the displayed title. */
  id: string;
  /** The file name, shown in the note list (FR-NOTE-7). */
  title: string;
  /** Folder path under notes/, nested allowed (FR-FILE-5). */
  category: string;
  /** File birthtime where the platform provides it, else mtime. */
  created: string;
  /** File mtime — the ordering key (FR-NOTE-8, FR-UI-9). */
  updated: string;
}

export interface Note extends NoteMeta {
  body: string;
}

export interface NoteInput {
  /** Desired name; the file is named after it (FR-NOTE-7). */
  title?: string;
  category?: string;
  body?: string;
}

/** A leading YAML block written by an earlier release (FR-NOTE-9). */
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/**
 * Filesystem-backed note store. Notes are plain Markdown files; the filesystem
 * *is* the metadata (FR-NOTE-5, FR-NOTE-7, FR-NOTE-8).
 */
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

  /** List note metadata, newest-modified first (FR-NOTE-8, FR-UI-9). */
  list(category?: string): NoteMeta[] {
    const categories = category ? [category] : this.listCategories();
    const notes: NoteMeta[] = [];
    for (const cat of categories) {
      const dir = this.categoryDir(cat);
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.md')) continue;
        const meta = this.readMeta(join(dir, file), cat);
        if (meta) notes.push(meta);
      }
    }
    // Sort on the file's modification time, so notes edited outside Mnemo are
    // ordered correctly too.
    return notes.sort((a, b) => b.updated.localeCompare(a.updated));
  }

  /** Metadata read from the file's name and stat, without loading the body. */
  private readMeta(path: string, category: string): NoteMeta | null {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return null;
    }
    const id = basename(path, '.md');
    return {
      id,
      title: id,
      category,
      created: (stat.birthtimeMs ? stat.birthtime : stat.mtime).toISOString(),
      updated: stat.mtime.toISOString()
    };
  }

  private readFile(path: string, category: string): Note | null {
    if (!existsSync(path)) return null;
    const meta = this.readMeta(path, category);
    if (!meta) return null;
    const raw = readFileSync(path, 'utf8');
    // Files written before the frontmatter-free model may still start with a
    // YAML block. Hide it from the editor instead of showing it as content; it
    // disappears from disk only when the user saves (FR-NOTE-9, NFR-1b).
    // Trimmed at both ends so a read → save round trip is stable (the file is
    // written back with exactly one trailing newline).
    return { ...meta, body: raw.replace(FRONTMATTER, '').trim() };
  }

  /** Locate a note by id (its file name) across all categories. */
  get(id: string): Note | null {
    for (const cat of this.listCategories()) {
      const path = this.filePath(cat, id);
      if (existsSync(path)) return this.readFile(path, cat);
    }
    return null;
  }

  create(input: NoteInput, _now: string): Note {
    void _now; // timestamps come from the filesystem (FR-NOTE-8)
    const category = sanitizeCategory(input.category ?? 'inbox') || 'inbox';
    this.createCategory(category);
    const id = this.uniqueName(category, fileNameFor(input.title));
    this.writeBody(category, id, input.body ?? '');
    return this.readFile(this.filePath(category, id), category)!;
  }

  update(id: string, input: NoteInput, _now: string): Note | null {
    void _now;
    const existing = this.get(id);
    if (!existing) return null;

    const nextCategory =
      input.category !== undefined
        ? sanitizeCategory(input.category) || 'inbox'
        : existing.category;
    // Renaming the note renames the file, so name, id and displayed title stay
    // the same thing (FR-NOTE-7).
    const desired = input.title !== undefined ? fileNameFor(input.title) : existing.id;
    const oldPath = this.filePath(existing.category, existing.id);

    let nextId = existing.id;
    if (desired !== existing.id || nextCategory !== existing.category) {
      this.createCategory(nextCategory);
      nextId =
        desired === existing.id && nextCategory !== existing.category
          ? this.uniqueName(nextCategory, desired, existing.id)
          : this.uniqueName(nextCategory, desired);
      if (existsSync(oldPath)) {
        renameSync(oldPath, this.filePath(nextCategory, nextId));
      }
    }

    if (input.body !== undefined) {
      this.writeBody(nextCategory, nextId, input.body);
    } else if (!existsSync(this.filePath(nextCategory, nextId))) {
      this.writeBody(nextCategory, nextId, existing.body);
    }
    return this.readFile(this.filePath(nextCategory, nextId), nextCategory);
  }

  delete(id: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    const path = this.filePath(existing.category, existing.id);
    if (existsSync(path)) rmSync(path);
    return true;
  }

  /** Write the note as plain Markdown — never a frontmatter block (FR-NOTE-5). */
  private writeBody(category: string, id: string, body: string): void {
    mkdirSync(this.categoryDir(category), { recursive: true });
    const text = body.replace(FRONTMATTER, '').trim();
    writeFileSync(this.filePath(category, id), text ? `${text}\n` : '', 'utf8');
  }

  /** `name`, or `name-2`, `name-3`, … when the file already exists. */
  private uniqueName(category: string, name: string, allow?: string): string {
    let candidate = name;
    let n = 2;
    while (candidate !== allow && existsSync(this.filePath(category, candidate))) {
      candidate = `${name}-${n++}`;
    }
    return candidate;
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

/**
 * Turn a title into the note's file name (FR-NOTE-7). The name is what the user
 * sees in the list, so non-ASCII titles are kept as-is; only characters that
 * are unsafe in a path — separators, control characters, and the Windows
 * reserved set — are replaced.
 */
export function fileNameFor(title: string | undefined): string {
  // Path separators, the Windows-reserved set and control characters. Listed
  // explicitly rather than as one big range so letters and digits survive.
  // eslint-disable-next-line no-control-regex
  const UNSAFE = /[\u0000-\u001f<>:"/\\|?*]+/g;
  const cleaned = (title ?? '')
    .replace(UNSAFE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // A leading or trailing dot makes a hidden or awkward file name.
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .slice(0, 80)
    .trim();
  return cleaned || 'Untitled';
}
