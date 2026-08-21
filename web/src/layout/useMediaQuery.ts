import { useEffect, useState } from 'react';

/**
 * Live media-query match. The shell switches between the resizable pane group
 * and the narrow-screen stack as the viewport crosses the breakpoint, so a
 * rotation or a resized window is picked up without a reload (FR-UI-11).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    // Re-read on subscribe: the query may have changed since the initial state.
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/** Tailwind's `md` breakpoint — above it the three panes fit side by side. */
export const WIDE_QUERY = '(min-width: 768px)';
