import { useEffect, useRef, useState } from 'react';
import { api, type Note } from '../api.js';
import { LiveMarkdownEditor } from '../editor/LiveMarkdownEditor.js';

export function NoteEditor(props: {
  noteId: string;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [note, setNote] = useState<Note | null>(null);
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
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
      setTags(n.tags.join(', '));
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
  }, [title, tags, body, dirty]);

  async function save() {
    if (!note) return;
    setSaving(true);
    await api.updateNote(note.id, {
      title,
      body,
      tags: tags.split(',').map((t) => t.trim()).filter(Boolean)
    });
    setSaving(false);
    setDirty(false);
    props.onSaved();
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
          placeholder="Untitled"
          onChange={(e) => {
            setTitle(e.target.value);
            setDirty(true);
          }}
        />
        <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
          <span className="rounded bg-muted px-2 py-0.5">{note.category}</span>
          <input
            className="flex-1 outline-none"
            value={tags}
            placeholder="tags, comma, separated"
            onChange={(e) => {
              setTags(e.target.value);
              setDirty(true);
            }}
          />
          {note.source && (
            <a className="text-accent underline" href={note.source} target="_blank" rel="noreferrer">
              source
            </a>
          )}
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
