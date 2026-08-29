import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  keymap,
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { Table } from '@lezer/markdown';
import {
  livePreviewPlugin,
  markdownStylePlugin,
  editorTheme,
  mouseSelectingField,
  collapseOnSelectionFacet,
  setMouseSelecting,
  codeBlockField,
  linkPlugin,
  imageField,
  tableField,
  initHighlighter
} from 'codemirror-live-markdown';

/**
 * Renders a bullet (•) or the original number for list items whose marker the
 * live-preview plugin hides. codemirror-live-markdown only *hides* the `-`/`*`
 * ListMark and draws no marker of its own, so lists otherwise look like plain
 * text. We add a marker on inactive lines only (the raw marker is shown while
 * the cursor is on the line), mirroring Obsidian's behavior.
 */
const listMarkerPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet) {
        this.decorations = this.build(u.view);
      }
    }
    build(view: EditorView): DecorationSet {
      const { state } = view;
      const active = new Set<number>();
      for (const r of state.selection.ranges) {
        const a = state.doc.lineAt(r.from).number;
        const b = state.doc.lineAt(r.to).number;
        for (let l = a; l <= b; l++) active.add(l);
      }
      const ranges: Array<{ from: number; deco: Decoration }> = [];
      const seen = new Set<number>();
      for (const { from, to } of view.visibleRanges) {
        syntaxTree(state).iterate({
          from,
          to,
          enter: (node) => {
            if (node.name !== 'ListItem') return;
            const line = state.doc.lineAt(node.from);
            if (seen.has(line.from)) return;
            const m = line.text.match(/^(\s*)([-*+]|\d+[.)])\s/);
            if (!m) return;
            seen.add(line.from);
            if (active.has(line.number)) return; // show raw marker while editing
            const ordered = /\d/.test(m[2]);
            ranges.push({
              from: line.from,
              deco: Decoration.line({
                class: ordered ? 'cm-md-li cm-md-li-ordered' : 'cm-md-li cm-md-li-bullet',
                attributes: ordered ? { 'data-num': m[2] } : undefined
              })
            });
          }
        });
      }
      ranges.sort((x, y) => x.from - y.from);
      return Decoration.set(ranges.map((r) => r.deco.range(r.from)));
    }
  },
  { decorations: (v) => v.decorations }
);

/** The syntax-tree node type, taken from `syntaxTree` so `@lezer/common` need
 *  not be added as a direct dependency just for a type. */
type MdNode = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>;

/** Schemes a note link may open. Anything else (notably `javascript:`) is left
 *  alone — the same rule `rehype-sanitize` enforces for chat replies. */
const OPENABLE_SCHEME = /^(https?|mailto):$/i;

/** A bare URL typed into the body, for the case the parser did not autolink it. */
const BARE_URL = /(?:https?:\/\/|mailto:)[^\s<>()[\]{}'"`]+/g;

/**
 * The link under `pos`, or null. Resolved against the **syntax tree** rather
 * than the rendered element, so it works whether codemirror-live-markdown draws
 * an anchor or a styled span, and keeps working if that markup changes.
 */
function linkAt(view: EditorView, pos: number): { href: string; from: number; to: number } | null {
  const { state } = view;
  for (let n: MdNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === 'URL') {
      // An image's URL is not a link to follow.
      if (n.parent?.name === 'Image') return null;
      const href = state.doc.sliceString(n.from, n.to).replace(/^<|>$/g, '').trim();
      return { href, from: n.from, to: n.to };
    }
    if (n.name === 'Image') return null;
    if (n.name === 'Link') {
      // Inline link `[text](url)`; a reference link has no URL child to follow.
      const url = n.getChild('URL');
      if (!url) return null;
      return { href: state.doc.sliceString(url.from, url.to).trim(), from: n.from, to: n.to };
    }
    if (n.name === 'Document') break;
  }
  const line = state.doc.lineAt(pos);
  BARE_URL.lastIndex = 0;
  for (let m = BARE_URL.exec(line.text); m; m = BARE_URL.exec(line.text)) {
    const from = line.from + m.index;
    const to = from + m[0].length;
    if (pos >= from && pos <= to) return { href: m[0], from, to };
  }
  return null;
}

/**
 * Open a URL in a note in a **separate tab** (FR-NOTE-10).
 *
 * The note surface is this editor, not the HTML renderer the chat view uses
 * (`web/src/markdown.tsx`, FR-CHAT-10), so the rule is implemented on the click
 * rather than with an `<a target="_blank">` override. Handling `mousedown` (and
 * returning true, which makes CodeMirror call `preventDefault`) intercepts the
 * click *before* the caret is placed, and the Mnemo tab never navigates — so
 * following a reference cannot lose an unsaved edit.
 *
 * Authoring still wins: a modifier-held click, and a click while the caret is
 * already inside that link, fall through to CodeMirror so the URL can be
 * edited. The document is never modified — this is presentation only, and the
 * stored Markdown keeps the URL exactly as written.
 */
function openLinkOnClick(event: MouseEvent, view: EditorView): boolean {
  if (event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos == null) return false;
  const link = linkAt(view, pos);
  if (!link) return false;
  for (const r of view.state.selection.ranges) {
    if (r.from <= link.to && r.to >= link.from) return false; // caret is in it: edit
  }
  let url: URL;
  try {
    // No base: a relative path or a `[[wiki link]]` is not a URL and is left
    // to in-app navigation rather than opened externally (FR-NOTE-6).
    url = new URL(link.href);
  } catch {
    return false;
  }
  if (!OPENABLE_SCHEME.test(url.protocol)) return false;
  // The scripted equivalent of rel="noreferrer noopener": the opened page gets
  // no `window.opener` handle back to Mnemo.
  window.open(url.href, '_blank', 'noopener,noreferrer');
  return true;
}

const linkOpener = EditorView.domEventHandlers({
  mousedown: (event, view) => openLinkOnClick(event, view)
});

/**
 * Obsidian-style live Markdown editor (FR-NOTE-2, FR-NOTE-3).
 *
 * Built on CodeMirror 6 with codemirror-live-markdown, composed like its demo
 * (https://codemirror-live-markdown.vercel.app/): live preview, styling, code
 * blocks (syntax highlighted), links, images, and tables — plus a list-marker
 * plugin so `-`/`*`/ordered lists render visibly.
 */
export function LiveMarkdownEditor(props: {
  value: string;
  onChange: (value: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;

  useEffect(() => {
    let disposed = false;
    let view: EditorView | null = null;
    const onMouseUp = () =>
      requestAnimationFrame(() => view?.dispatch({ effects: setMouseSelecting.of(false) }));

    (async () => {
      // Initialize the syntax highlighter used by codeBlockField (best-effort).
      try {
        await initHighlighter();
      } catch {
        /* highlighting is optional; the editor still works without it */
      }
      if (disposed || !hostRef.current) return;

      const updateListener = EditorView.updateListener.of((u) => {
        if (u.docChanged) onChangeRef.current(u.state.doc.toString());
      });
      const common = [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        updateListener
      ];
      const live = [
        markdown({ base: markdownLanguage, extensions: [Table] }),
        collapseOnSelectionFacet.of(true),
        mouseSelectingField,
        livePreviewPlugin,
        markdownStylePlugin,
        codeBlockField(),
        linkPlugin(),
        imageField(),
        tableField,
        listMarkerPlugin,
        linkOpener,
        editorTheme,
        ...common
      ];

      let state: EditorState;
      try {
        state = EditorState.create({ doc: props.value, extensions: live });
      } catch {
        // Defensive fallback (the live-preview package is pre-release): keep a
        // working plain Markdown editor even if a live extension fails to build.
        state = EditorState.create({
          doc: props.value,
          extensions: [markdown({ base: markdownLanguage }), linkOpener, ...common]
        });
      }
      view = new EditorView({ state, parent: hostRef.current });
      viewRef.current = view;

      const onMouseDown = () => view?.dispatch({ effects: setMouseSelecting.of(true) });
      view.contentDOM.addEventListener('mousedown', onMouseDown);
      document.addEventListener('mouseup', onMouseUp);
    })();

    return () => {
      disposed = true;
      document.removeEventListener('mouseup', onMouseUp);
      view?.destroy();
      viewRef.current = null;
    };
    // Re-create the editor only when the note identity changes (see key prop).
  }, []);

  // Keep external value changes (e.g. switching notes) in sync.
  useEffect(() => {
    const view = viewRef.current;
    if (view && props.value !== view.state.doc.toString()) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: props.value }
      });
    }
  }, [props.value]);

  return <div ref={hostRef} className="h-full w-full overflow-auto" />;
}
