import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type NoteMeta } from './api.js';
import { NoteEditor } from './panes/NoteEditor.js';
import { SchedulerList } from './panes/SchedulerList.js';
import { SchedulerDetail } from './panes/SchedulerDetail.js';
import { ChatView } from './panes/ChatView.js';
import { SettingsView } from './panes/SettingsView.js';
import { NotesIcon, ChatIcon, SchedulerIcon, SettingsIcon } from './icons.js';
import {
  PaneGroup,
  Pane,
  PaneDivider,
  type ImperativePanelHandle
} from './layout/PaneGroup.js';
import {
  BottomNav,
  MobileShell,
  StageHeader,
  type NavItem,
  type Stage
} from './layout/MobileShell.js';
import { useMediaQuery, WIDE_QUERY } from './layout/useMediaQuery.js';

type View = 'notes' | 'chat' | 'scheduler' | 'settings';

const NAV_ITEMS: ReadonlyArray<NavItem<View>> = [
  { id: 'notes', label: 'Notes', Icon: NotesIcon },
  { id: 'chat', label: 'Chat', Icon: ChatIcon },
  { id: 'scheduler', label: 'Scheduler', Icon: SchedulerIcon },
  { id: 'settings', label: 'Settings', Icon: SettingsIcon }
];

/** Pane widths, in pixels. Percentages are derived from the group (FR-UI-10). */
const LEFT = { defaultPx: 240, minPx: 168, collapsedPx: 48 };
const MID = { defaultPx: 320, minPx: 208, collapsedPx: 36 };
const RIGHT = { minPx: 300 };

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
    <div className="flex h-full min-w-0 flex-col items-center bg-muted/40 pt-3">
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
    <div className="flex h-full min-w-0 flex-col items-center gap-1 bg-muted/40 py-2">
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

/**
 * Left pane: branding, view navigation and the folder tree (FR-UI-2).
 * On the narrow layout the view navigation moves to the bottom bar and the
 * collapse control disappears, so both are optional here (FR-UI-11).
 */
function Sidebar(props: {
  view: View;
  onView: (v: View) => void;
  categories: string[];
  category: string;
  onCategory: (c: string) => void;
  onAddCategory: (parent?: string) => void;
  showNav: boolean;
  onCollapse?: () => void;
  touch?: boolean;
}) {
  // py-3 keeps a folder row at the 44px touch target (FR-UI-11).
  const rowPad = props.touch ? 'py-3' : 'py-1';
  return (
    <aside className="flex h-full min-w-0 flex-col bg-muted/40">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-lg font-bold">Mnemo</h1>
          <p className="truncate text-[11px] text-gray-500">Memory &amp; knowledge archive</p>
        </div>
        {props.onCollapse && (
          <ChevBtn glyph="«" title="Collapse sidebar" onClick={props.onCollapse} />
        )}
      </div>
      {props.showNav && (
        <nav className="px-2 py-2 text-sm">
          {NAV_ITEMS.map(({ id, label, Icon }) => (
            <button
              key={id}
              className={`mb-0.5 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left ${
                props.view === id ? 'bg-accent text-white' : 'hover:bg-muted'
              }`}
              onClick={() => props.onView(id)}
            >
              <Icon className="shrink-0" />
              {label}
            </button>
          ))}
        </nav>
      )}
      {props.view === 'notes' && (
        <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
          <div className="mb-1 flex items-center justify-between px-2 text-xs font-semibold uppercase text-gray-400">
            Folders
            <button
              className={`text-accent ${props.touch ? 'h-11 w-11' : ''}`}
              onClick={() => props.onAddCategory()}
              title="Add folder"
              aria-label="Add folder"
            >
              +
            </button>
          </div>
          {props.categories.map((c) => {
            const depth = c.split('/').length - 1;
            const label = c.split('/').pop();
            return (
              <div key={c} className="group flex items-center">
                <button
                  className={`min-w-0 flex-1 truncate rounded px-2 ${rowPad} text-left text-sm ${
                    c === props.category ? 'bg-muted font-medium' : 'hover:bg-muted'
                  }`}
                  style={{ paddingLeft: `${8 + depth * 12}px` }}
                  title={c}
                  onClick={() => props.onCategory(c)}
                >
                  {depth > 0 && <span className="text-gray-300">└ </span>}
                  {label}
                </button>
                <button
                  className={`px-1 text-gray-400 hover:text-accent ${
                    props.touch ? 'h-11 w-11' : 'opacity-0 group-hover:opacity-100'
                  }`}
                  title={`Add sub-folder under ${c}`}
                  aria-label={`Add sub-folder under ${c}`}
                  onClick={() => props.onAddCategory(c)}
                >
                  +
                </button>
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}

/** Middle pane for Notes: search, "new note", and the note list (FR-UI-3). */
function NoteListPane(props: {
  leading?: ReactNode;
  query: string;
  onQuery: (q: string) => void;
  notes: NoteMeta[];
  selected: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  touch?: boolean;
}) {
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        {props.leading}
        <input
          className="min-w-0 flex-1 rounded border border-border px-2 py-1 text-sm outline-none"
          placeholder="Search…"
          value={props.query}
          onChange={(e) => props.onQuery(e.target.value)}
        />
        <button
          className={`shrink-0 rounded bg-accent text-sm font-medium text-white ${
            props.touch ? 'h-11 w-11' : 'px-2 py-1'
          }`}
          onClick={props.onNew}
          title="New note"
          aria-label="New note"
        >
          +
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {props.notes.map((n) => (
          <button
            key={n.id}
            className={`block w-full border-b border-border px-4 py-3 text-left hover:bg-muted ${
              props.selected === n.id ? 'bg-muted' : ''
            }`}
            onClick={() => props.onSelect(n.id)}
          >
            {/* The file name is the note's identity (FR-NOTE-7), and
                the file's mtime its recency (FR-NOTE-8). */}
            <div className="truncate font-medium">{n.title}</div>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500">
              <span>{new Date(n.updated).toLocaleString()}</span>
            </div>
          </button>
        ))}
        {!props.notes.length && (
          <p className="p-4 text-sm text-gray-400">No notes. Create one with “+”.</p>
        )}
      </div>
    </section>
  );
}

/** Middle pane for the Scheduler, with the same collapse/back slot. */
function SchedulerListPane(props: {
  leading?: ReactNode;
  trailing?: ReactNode;
  selected: string | 'new' | null;
  onSelect: (sel: string | 'new') => void;
  reloadSignal: number;
}) {
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex items-center justify-between border-b border-border px-2 py-1">
        <div className="flex min-w-0 items-center gap-1">
          {props.leading}
          <span className="px-1 text-xs font-semibold uppercase text-gray-400">Tasks</span>
        </div>
        {props.trailing}
      </div>
      <div className="min-h-0 flex-1">
        <SchedulerList
          selected={props.selected}
          onSelect={props.onSelect}
          reloadSignal={props.reloadSignal}
        />
      </div>
    </section>
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

  // Pane collapse state (FR-UI-6). These are *driven by* the panes: a drag past
  // the minimum width and the chevron button both go through the panel, whose
  // onCollapse/onExpand set these, so the two routes cannot disagree (FR-UI-10).
  const [leftOpen, setLeftOpen] = useState(true);
  const [midOpen, setMidOpen] = useState(true);
  const leftPane = useRef<ImperativePanelHandle>(null);
  const midPane = useRef<ImperativePanelHandle>(null);

  // Narrow layout: one pane at a time, walked with a back control (FR-UI-11).
  const isWide = useMediaQuery(WIDE_QUERY);
  const [stage, setStage] = useState<Stage>('nav');

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

  // Each view enters at its first stage; the Scheduler has no folder stage.
  useEffect(() => {
    setStage(view === 'notes' ? 'nav' : 'list');
  }, [view]);

  async function newNote() {
    // The name becomes the file name and the list entry (FR-NOTE-7).
    const name = window.prompt('Note name', 'Untitled')?.trim();
    if (name === undefined) return;
    const note = await api.createNote({ title: name || 'Untitled', category, body: '' });
    await loadNotes();
    setView('notes');
    setSelected(note.id);
    setStage('detail');
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

  function selectCategory(c: string) {
    setCategory(c);
    setQuery('');
    // Re-clicking the selected category still refreshes (FR-UI-7).
    setNotesReload((n) => n + 1);
    setStage('list');
  }

  const isThreePane = view === 'notes' || view === 'scheduler';

  // ---- Pane content, shared by both shells -------------------------------

  const sidebar = (opts: { showNav: boolean; onCollapse?: () => void; touch?: boolean }) => (
    <Sidebar
      view={view}
      onView={setView}
      categories={categories}
      category={category}
      onCategory={selectCategory}
      onAddCategory={addCategory}
      showNav={opts.showNav}
      onCollapse={opts.onCollapse}
      touch={opts.touch}
    />
  );

  const noteList = (opts: { leading?: ReactNode; touch?: boolean }) => (
    <NoteListPane
      leading={opts.leading}
      query={query}
      onQuery={setQuery}
      notes={notes}
      selected={selected}
      onSelect={(id) => {
        setSelected(id);
        setStage('detail');
      }}
      onNew={newNote}
      touch={opts.touch}
    />
  );

  const noteDetail = selected ? (
    <NoteEditor
      noteId={selected}
      onSaved={(id) => {
        // Renaming changes the id; follow it so the selection holds.
        setSelected(id);
        void loadNotes();
      }}
      onDeleted={() => {
        setSelected(null);
        setStage('list');
        void loadNotes();
      }}
    />
  ) : (
    <div className="flex h-full items-center justify-center text-sm text-gray-400">
      Select or create a note.
    </div>
  );

  const schedulerList = (opts: { leading?: ReactNode; trailing?: ReactNode }) => (
    <SchedulerListPane
      leading={opts.leading}
      trailing={opts.trailing}
      selected={schedSel}
      onSelect={(sel) => {
        setSchedSel(sel);
        setStage('detail');
      }}
      reloadSignal={schedReload}
    />
  );

  const schedulerDetail = (
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
        setStage('list');
        setSchedReload((n) => n + 1);
      }}
    />
  );

  // ---- Narrow layout (FR-UI-5, FR-UI-11) --------------------------------

  if (!isWide) {
    const bottomNav = <BottomNav items={NAV_ITEMS} active={view} onSelect={setView} />;

    let body: ReactNode;
    if (view === 'chat') {
      body = <ChatView />;
    } else if (view === 'settings') {
      body = <SettingsView />;
    } else if (view === 'notes') {
      if (stage === 'nav') {
        body = sidebar({ showNav: false, touch: true });
      } else if (stage === 'list') {
        body = (
          <div className="flex h-full min-h-0 flex-col">
            <StageHeader
              title={query.trim() ? 'Search results' : category}
              onBack={() => setStage('nav')}
              backLabel="Back to folders"
            />
            <div className="min-h-0 flex-1">{noteList({ touch: true })}</div>
          </div>
        );
      } else {
        body = (
          <div className="flex h-full min-h-0 flex-col">
            <StageHeader
              title={notes.find((n) => n.id === selected)?.title ?? 'Note'}
              onBack={() => setStage('list')}
              backLabel="Back to note list"
            />
            <div className="min-h-0 flex-1">{noteDetail}</div>
          </div>
        );
      }
    } else if (stage === 'detail') {
      body = (
        <div className="flex h-full min-h-0 flex-col">
          <StageHeader
            title="Task"
            onBack={() => setStage('list')}
            backLabel="Back to task list"
          />
          <div className="min-h-0 flex-1">{schedulerDetail}</div>
        </div>
      );
    } else {
      body = schedulerList({});
    }

    return <MobileShell nav={bottomNav}>{body}</MobileShell>;
  }

  // ---- Wide layout: resizable, drag-collapsible panes (FR-UI-6, FR-UI-10) --

  // One saved layout per pane *shape*: Notes and Scheduler share the three-pane
  // arrangement, Chat and Settings the two-pane one, so switching between two
  // views of the same shape keeps the widths the user dragged.
  const shape = isThreePane ? 'three' : 'two';

  return (
    <PaneGroup key={shape} autoSaveId={`mnemo:layout:${shape}`}>
      {/* Left pane: navigation + categories (FR-UI-2), collapsible (FR-UI-6) */}
      <Pane
        id="left"
        order={1}
        {...LEFT}
        ref={leftPane}
        onCollapsedChange={(collapsed) => setLeftOpen(!collapsed)}
      >
        {leftOpen ? (
          sidebar({ showNav: true, onCollapse: () => leftPane.current?.collapse() })
        ) : (
          <CollapsedLeftRail
            view={view}
            onView={setView}
            onExpand={() => leftPane.current?.expand()}
          />
        )}
      </Pane>
      <PaneDivider label="Resize sidebar" />

      {isThreePane && (
        <>
          <Pane
            id="mid"
            order={2}
            {...MID}
            ref={midPane}
            onCollapsedChange={(collapsed) => setMidOpen(!collapsed)}
          >
            {!midOpen ? (
              <CollapsedRail label="list" onExpand={() => midPane.current?.expand()} />
            ) : view === 'notes' ? (
              noteList({
                leading: (
                  <ChevBtn
                    glyph="«"
                    title="Collapse list"
                    onClick={() => midPane.current?.collapse()}
                  />
                )
              })
            ) : (
              schedulerList({
                trailing: (
                  <ChevBtn
                    glyph="«"
                    title="Collapse list"
                    onClick={() => midPane.current?.collapse()}
                  />
                )
              })
            )}
          </Pane>
          <PaneDivider label="Resize list" />
        </>
      )}

      {/* Right pane: editor / detail (FR-UI-4) */}
      <Pane id="right" order={3} {...RIGHT} className="min-w-0 overflow-hidden">
        {view === 'notes'
          ? noteDetail
          : view === 'scheduler'
            ? schedulerDetail
            : view === 'chat'
              ? <ChatView />
              : <SettingsView />}
      </Pane>
    </PaneGroup>
  );
}
