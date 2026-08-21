import {
  createContext,
  forwardRef,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from 'react';
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle
} from 'react-resizable-panels';

export type { ImperativePanelHandle };

/**
 * react-resizable-panels sizes panels as a percentage of the group, but what we
 * actually want to constrain is pixels: an icon rail is as wide as its icons,
 * and a note list stops being readable below a certain width. A percentage that
 * reads as 48px on a laptop reads as 20px on a wide monitor, so the group
 * publishes its measured width and each pane converts (FR-UI-10).
 */
const GroupWidth = createContext(0);

/**
 * Horizontal pane group with draggable dividers (FR-UI-6, FR-UI-10).
 *
 * `autoSaveId` persists the layout — pane widths *and* collapsed flags — in
 * localStorage, so the arrangement survives a reload. That is per-device
 * presentation state, which is why it deliberately does not go into
 * `data/config.json`, where two browsers would fight over one layout.
 */
export function PaneGroup(props: { autoSaveId: string; children: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={host} className="h-full">
      {/* Constraints are pixel-derived, so the group waits for its first
          measurement instead of mounting with placeholder percentages and
          then collapsing panes a frame later. useLayoutEffect measures before
          paint, so the wait is not visible. */}
      {width > 0 && (
        <GroupWidth.Provider value={width}>
          <PanelGroup
            direction="horizontal"
            autoSaveId={props.autoSaveId}
            className="h-full"
          >
            {props.children}
          </PanelGroup>
        </GroupWidth.Provider>
      )}
    </div>
  );
}

type PaneProps = {
  id: string;
  order: number;
  /**
   * Width the pane opens at, in pixels, when no saved layout applies. Omit on
   * the pane that should absorb whatever the others leave over.
   */
  defaultPx?: number;
  /** Narrowest the pane may be dragged before it collapses, in pixels. */
  minPx: number;
  /** Rail width the pane collapses to. Omit to make the pane non-collapsible. */
  collapsedPx?: number;
  className?: string;
  /** Called when a drag (or the imperative handle) collapses or expands. */
  onCollapsedChange?: (collapsed: boolean) => void;
  children: ReactNode;
};

/**
 * One pane of a `PaneGroup`. Sizes are given in pixels and converted against
 * the measured group width; a collapsible pane snaps shut once dragged under
 * `minPx` and reopens when the divider is dragged back out (FR-UI-10).
 */
export const Pane = forwardRef<ImperativePanelHandle, PaneProps>(function Pane(
  { id, order, defaultPx, minPx, collapsedPx, className, onCollapsedChange, children },
  ref
) {
  const groupWidth = useContext(GroupWidth);
  const pct = (px: number) => Math.min(100, (px / groupWidth) * 100);
  const collapsible = collapsedPx !== undefined;

  return (
    <Panel
      ref={ref}
      id={id}
      order={order}
      className={className}
      defaultSize={defaultPx === undefined ? undefined : pct(defaultPx)}
      minSize={pct(minPx)}
      collapsible={collapsible}
      collapsedSize={collapsedPx === undefined ? undefined : pct(collapsedPx)}
      onCollapse={collapsible ? () => onCollapsedChange?.(true) : undefined}
      onExpand={collapsible ? () => onCollapsedChange?.(false) : undefined}
    >
      {children}
    </Panel>
  );
});

/**
 * The divider between two panes: a 1px rule at rest that lights up as a grab
 * strip on hover, drag or keyboard focus. The library gives it
 * `role="separator"`, `tabIndex=0`, arrow/Home/End resizing and F6 handle
 * cycling; the label says which boundary it moves (FR-UI-10).
 */
export function PaneDivider(props: { label: string }) {
  return (
    <PanelResizeHandle
      aria-label={props.label}
      // The pointer hit area extends past the 1px rule so the divider can be
      // grabbed without pixel-hunting; coarse pointers get a wider margin.
      hitAreaMargins={{ coarse: 15, fine: 5 }}
      className="group relative w-px shrink-0 cursor-col-resize bg-border outline-none"
    >
      {/* Drawn as an overlay rather than by widening the handle, so
          highlighting the boundary never shifts the panes on either side. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 bg-transparent transition-colors group-hover:bg-accent/50 group-focus-visible:bg-accent group-data-[resize-handle-state=hover]:bg-accent/50 group-data-[resize-handle-state=drag]:bg-accent"
      />
    </PanelResizeHandle>
  );
}
