import { useCallback, useEffect, useState } from 'react';
import { api, type NoteMeta } from './api.js';
import { NoteEditor } from './panes/NoteEditor.js';
import { SchedulerList } from './panes/SchedulerList.js';
import { SchedulerDetail } from './panes/SchedulerDetail.js';
import { ChatView } from './panes/ChatView.js';
import { SettingsView } from './panes/SettingsView.js';
import { NotesIcon, ChatIcon, SchedulerIcon, SettingsIcon } from './icons.js';

type View = 'notes' | 'chat' | 'scheduler' | 'settings';

const NAV_ITEMS: Array<{ id: View; label: string; Icon: (p: { className?: string }) => JSX.Element }> = [
  { id: 'notes', label: 'Notes', Icon: NotesIcon },
  { id: 'chat', label: 'Chat', Icon: ChatIcon },
  { id: 'scheduler', label: 'Scheduler', Icon: SchedulerIcon },
  { id: 'settings', label: 'Settings', Icon: SettingsIcon }
];

/** Small chevron button used for collapse/expand controls (FR-UI-6). */
function ChevBtn(props: { glyph: string; title: string; onClick: () => void }) {
  return (
    <button
      className="rounded px-1 text-gray-500 hover:bg-muted"
      title={props.title}
      onClick={props.onClick}
    >
      {props.glyph}
    </button>
  );
}

/** Slim rail shown in place of a collapsed middle pane, with an expand button. */
function CollapsedRail(props: { onExpand: () => void; label: string }) {
  return (
    <div className="flex flex-col items-center border-r border-border bg-muted/40 pt-3">
      <ChevBtn glyph="»" title={`Expand ${props.label}`} onClick={props.onExpand} />
    </div>
  );
}

/** Icon-only left rail shown when the left pane is collapsed (FR-UI-8). */
function CollapsedLeftRail(props: {
  view: View;
  onView: (v: View) => void;
  onExpand: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-1 bg-muted/40 py-2">
      <ChevBtn glyph="»" title="Expand sidebar" onClick={props.onExpand} />
      {NAV_ITEMS.map(({ id, label, Icon }) => (
        <button
          key={id}
          title={label}
          aria-label={label}
          className={`flex h-9 w-9 items-center justify-center rounded ${
            props.view === id ? 'bg-accent text-white' : 'text-gray-600 hover:bg-muted'
          }`}
          onClick={() => props.onView(id)}
        >
          <Icon />
        </button>
      ))}
    </div>
  );
}

export function App() {
  const [view, setView] = useState<View>('notes');
  const [categories, setCategories] = useState<string[]>([]);
  const [category, setCategory] = useState<string>('inbox');
  const [notes, setNotes] = useState<NoteMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [notesReload, setNotesReload] = useState(0);

  // Pane collapse state (FR-UI-6).
  const [leftOpen, setLeftOpen] = useState(true);
  const [midOpen, setMidOpen] = useState(true);

  // Scheduler pane state (3-pane).
  const [schedSel, setSchedSel] = useState<string | 'new' | null>(null);
  const [schedReload, setSchedReload] = useState(0);

  const loadCategories = useCallback(async () => {
    const { categories } = await api.categories();
    setCategories(categories);
    if (categories.length && !categories.includes(category)) {
      setCategory(categories[0]);
    }
  }, [category]);

  const loadNotes = useCallback(async () => {
    if (query.trim()) {
      const { notes } = await api.search(query);
      setNotes(notes);
    } else {
      const { notes } = await api.notes(category);
      setNotes(notes);
    }
    // notesReload participates so re-clicking the same category refetches (FR-UI-7).
  }, [category, query, notesReload]);

  useEffect(() => {
    void loadCategories();
  }, [loadCategories]);
  useEffect(() => {
    void loadNotes();
  }, [loadNotes]);

  async function newNote() {
    // The name becomes the file name and the list entry (FR-NOTE-7).
    const name = window.prompt('Note name', 'Untitled')?.trim();
    if (name === undefined) return;
    const note = await api.createNote({ title: name || 'Untitled', category, body: '' });
    await loadNotes();
    setView('notes');
    setSelected(note.id);
  }

  async function addCategory(parent?: string) {
    const name = window.prompt(
      parent ? `New sub-folder under “${parent}”` : 'New folder name'
    );
    if (!name) return;
    const full = parent ? `${parent}/${name}` : name;
    await api.createCategory(full);
    await loadCategories();
    setCategory(full);
  }

  const isThreePane = view === 'notes' || view === 'scheduler';
  const leftCol = leftOpen ? '220px' : '3rem';
  const midCol = midOpen ? '300px' : '2.25rem';
  const gridCols = isThreePane ? `${leftCol} ${midCol} 1fr` : `${leftCol} 1fr`;

  return (
    <div className="grid h-full divide-x divide-border" style={{ gridTemplateColumns: gridCols }}>
      {/* Left pane: navigation + categories (FR-UI-2), collapsible (FR-UI-6) */}
      {leftOpen ? (
        <aside className="flex min-w-0 flex-col bg-muted/40">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="min-w-0">
              <h1 className="text-lg font-bold">Mnemo</h1>
              <p className="truncate text-[11px] text-gray-500">Memory &amp; knowledge archive</p>
            </div>
            <ChevBtn glyph="«" title="Collapse sidebar" onClick={() => setLeftOpen(false)} />
          </div>
          <nav className="px-2 py-2 text-sm">
            {NAV_ITEMS.map(({ id, label, Icon }) => (
              <button
                key={id}
                className={`mb-0.5 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left ${
                  view === id ? 'bg-accent text-white' : 'hover:bg-muted'
                }`}
                onClick={() => setView(id)}
              >
                <Icon className="shrink-0" />
                {label}
              </button>
            ))}
          </nav>
          {view === 'notes' && (
            <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
              <div className="mb-1 flex items-center justify-between px-2 text-xs font-semibold uppercase text-gray-400">
                Folders
                <button className="text-accent" onClick={() => addCategory()} title="Add folder">
                  +
                </button>
              </div>
              {categories.map((c) => {
                const depth = c.split('/').length - 1;
                const label = c.split('/').pop();
                return (
                  <div key={c} className="group flex items-center">
                    <button
                      className={`min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-sm ${
                        c === category ? 'bg-muted font-medium' : 'hover:bg-muted'
                      }`}
                      style={{ paddingLeft: `${8 + depth * 12}px` }}
                      title={c}
                      onClick={() => {
                        setCategory(c);
                        setQuery('');
                        // Re-clicking the selected category still refreshes (FR-UI-7).
                        setNotesReload((n) => n + 1);
                      }}
                    >
                      {depth > 0 && <span className="text-gray-300">└ </span>}
                      {label}
                    </button>
                    <button
                      className="px-1 text-gray-400 opacity-0 hover:text-accent group-hover:opacity-100"
                      title={`Add sub-folder under ${c}`}
                      onClick={() => addCategory(c)}
                    >
                      +
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </aside>
      ) : (
        <CollapsedLeftRail view={view} onView={setView} onExpand={() => setLeftOpen(true)} />
      )}

      {/* Middle + right panes. Notes / Scheduler are 3-pane; Chat / Settings span the rest. */}
      {view === 'notes' ? (
        <>
          {midOpen ? (
            <section className="flex min-h-0 min-w-0 flex-col">
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <ChevBtn glyph="«" title="Collapse list" onClick={() => setMidOpen(false)} />
                <input
                  className="flex-1 rounded border border-border px-2 py-1 text-sm outline-none"
                  placeholder="Search…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <button
                  className="rounded bg-accent px-2 py-1 text-sm font-medium text-white"
                  onClick={newNote}
                  title="New note"
                >
                  +
                </button>
              </div>
              <div className="min-h-0 flex-1 overflow-auto">
                {notes.map((n) => (
                  <button
                    key={n.id}
                    className={`block w-full border-b border-border px-4 py-3 text-left hover:bg-muted ${
                      selected === n.id ? 'bg-muted' : ''
                    }`}
                    onClick={() => setSelected(n.id)}
                  >
                    {/* The file name is the note's identity (FR-NOTE-7), and
                        the file's mtime its recency (FR-NOTE-8). */}
                    <div className="truncate font-medium">{n.title}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500">
                      <span>{new Date(n.updated).toLocaleString()}</span>
                    </div>
                  </button>
                ))}
                {!notes.length && (
                  <p className="p-4 text-sm text-gray-400">No notes. Create one with “+”.</p>
                )}
              </div>
            </section>
          ) : (
            <CollapsedRail label="list" onExpand={() => setMidOpen(true)} />
          )}

          {/* Right pane: editor / detail (FR-UI-4) */}
          <section className="min-h-0 min-w-0 overflow-hidden">
            {selected ? (
              <NoteEditor
                noteId={selected}
                onSaved={(id) => {
                  // Renaming changes the id; follow it so the selection holds.
                  setSelected(id);
                  void loadNotes();
                }}
                onDeleted={() => {
                  setSelected(null);
                  void loadNotes();
                }}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-gray-400">
                Select or create a note.
              </div>
            )}
          </section>
        </>
      ) : view === 'chat' ? (
        <section className="min-h-0 min-w-0 overflow-hidden">
          <ChatView />
        </section>
      ) : view === 'scheduler' ? (
        <>
          {midOpen ? (
            <section className="flex min-h-0 min-w-0 flex-col">
              <div className="flex items-center justify-between border-b border-border px-2 py-1">
                <span className="px-1 text-xs font-semibold uppercase text-gray-400">Tasks</span>
                <ChevBtn glyph="«" title="Collapse list" onClick={() => setMidOpen(false)} />
              </div>
              <div className="min-h-0 flex-1">
                <SchedulerList
                  selected={schedSel}
                  onSelect={setSchedSel}
                  reloadSignal={schedReload}
                />
              </div>
            </section>
          ) : (
            <CollapsedRail label="list" onExpand={() => setMidOpen(true)} />
          )}
          <section className="min-h-0 min-w-0 overflow-hidden">
            <SchedulerDetail
              sel={schedSel}
              reloadSignal={schedReload}
              onChange={() => setSchedReload((n) => n + 1)}
              onCreated={(id) => {
                setSchedSel(id);
                setSchedReload((n) => n + 1);
              }}
              onDeleted={() => {
                setSchedSel(null);
                setSchedReload((n) => n + 1);
              }}
            />
          </section>
        </>
      ) : (
        <section className="min-h-0 min-w-0 overflow-hidden">
          <SettingsView />
        </section>
      )}
    </div>
  );
}
