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
          extensions: [markdown({ base: markdownLanguage }), ...common]
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
