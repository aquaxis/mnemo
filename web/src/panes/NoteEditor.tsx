import { useEffect, useRef, useState } from 'react';
import { api, type Note } from '../api.js';
import { LiveMarkdownEditor } from '../editor/LiveMarkdownEditor.js';

export function NoteEditor(props: {
  noteId: string;
  onSaved: (id: string) => void;
  onDeleted: () => void;
}) {
  const [note, setNote] = useState<Note | null>(null);
  // The title is the note's file name (FR-NOTE-7): editing it renames the file.
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    api.note(props.noteId).then((n) => {
      if (!active) return;
      setNote(n);
      setTitle(n.title);
      setBody(n.body);
      setDirty(false);
    });
    return () => {
      active = false;
    };
  }, [props.noteId]);

  // Debounced autosave (FR-NOTE-1, FR-NOTE-4).
  useEffect(() => {
    if (!dirty || !note) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void save(), 900);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [title, body, dirty]);

  async function save() {
    if (!note) return;
    setSaving(true);
    // Renaming changes the id (it is the file name), so keep the fresh note.
    const saved = await api.updateNote(note.id, { title, body });
    setNote(saved);
    setSaving(false);
    setDirty(false);
    props.onSaved(saved.id);
  }

  async function remove() {
    if (!note) return;
    await api.deleteNote(note.id);
    props.onDeleted();
  }

  if (!note) return <div className="p-6 text-sm text-gray-400">Loading…</div>;

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-4 py-3">
        <input
          className="w-full text-lg font-semibold outline-none"
          value={title}
          placeholder="Note name"
          onChange={(e) => {
            setTitle(e.target.value);
            setDirty(true);
          }}
        />
        <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
          <span className="rounded bg-muted px-2 py-0.5">{note.category}</span>
          <span className="flex-1 truncate" title="The title is the file name">
            {note.id}.md
          </span>
          <span>{saving ? 'Saving…' : dirty ? 'Unsaved' : 'Saved'}</span>
          <button className="text-red-500 hover:underline" onClick={remove}>
            Delete
          </button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        <LiveMarkdownEditor
          key={note.id}
          value={body}
          onChange={(v) => {
            setBody(v);
            setDirty(true);
          }}
        />
      </div>
    </div>
  );
}
