import type { ReactNode } from 'react';

/**
 * Narrow-screen shell (FR-UI-5, FR-UI-11).
 *
 * Three side-by-side panes do not fit a phone, so below the breakpoint the app
 * shows **one pane at a time** — a stage — with a back control to walk out of
 * it and a bottom bar to switch view. The panes themselves are the same
 * components the wide layout uses; only the container differs.
 */
export type Stage = 'nav' | 'list' | 'detail';

export type NavItem<T extends string> = {
  id: T;
  label: string;
  Icon: (p: { className?: string }) => JSX.Element;
};

export function MobileShell(props: { children: ReactNode; nav: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-hidden">{props.children}</div>
      {props.nav}
    </div>
  );
}

/**
 * Header of a stage. The collapse chevrons of the wide layout are meaningless
 * when only one pane is on screen, so the stage carries a back control instead
 * — the navigation FR-UI-11 requires to be reachable without dragging.
 */
export function StageHeader(props: {
  title: string;
  onBack?: () => void;
  backLabel?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
      {props.onBack && (
        <button
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded text-xl leading-none text-gray-600 hover:bg-muted"
          aria-label={props.backLabel ?? 'Back'}
          onClick={props.onBack}
        >
          ‹
        </button>
      )}
      <h2 className="min-w-0 flex-1 truncate px-1 text-sm font-semibold">{props.title}</h2>
      {props.actions}
    </header>
  );
}

/**
 * The view switcher, moved to the bottom of the screen on narrow layouts:
 * reachable by thumb, and one tap away from any stage.
 */
export function BottomNav<T extends string>(props: {
  items: ReadonlyArray<NavItem<T>>;
  active: T;
  onSelect: (id: T) => void;
}) {
  return (
    <nav
      aria-label="Views"
      className="flex shrink-0 border-t border-border bg-muted/40 pb-[env(safe-area-inset-bottom)]"
    >
      {props.items.map(({ id, label, Icon }) => (
        <button
          key={id}
          aria-current={props.active === id ? 'page' : undefined}
          // min-h-11 keeps the touch target at 44px (FR-UI-11).
          className={`flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] ${
            props.active === id ? 'text-accent' : 'text-gray-500'
          }`}
          onClick={() => props.onSelect(id)}
        >
          <Icon />
          {label}
        </button>
      ))}
    </nav>
  );
}
