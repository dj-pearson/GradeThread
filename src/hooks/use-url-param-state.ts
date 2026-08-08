import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

// URL-backed scalar state (US-958). Reads a single query param and writes it
// back with { replace: true } so updates don't pollute browser history. The
// value lives in the URL so it survives switching between the unified Inventory
// view modes (table/grid/kanban/prep) — each mode reads the same params.
//
// Writes use the functional updater form of setSearchParams so concurrent
// updates to *other* params (tab, filter, mode) in the same tick don't clobber
// each other. A value equal to `fallback` is dropped from the URL to keep it
// clean (the reader falls back to the same default).
export function useUrlParamState(
  key: string,
  fallback = "",
): [string, (value: string) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const value = searchParams.get(key) ?? fallback;
  const setValue = useCallback(
    (next: string) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next === "" || next === fallback) params.delete(key);
          else params.set(key, next);
          return params;
        },
        { replace: true },
      );
    },
    [key, fallback, setSearchParams],
  );
  return [value, setValue];
}

/** How long typing pauses before the URL (and the query it drives) catches up. */
const SEARCH_COMMIT_MS = 250;

/**
 * A text input backed by a URL param, for search boxes.
 *
 * `useUrlParamState` alone is wrong for a text field, and the way it fails is
 * easy to miss in hand-testing. Its value comes straight from the router, so a
 * controlled `<input value={search}>` re-renders from the URL — and a router
 * navigation is not synchronous. Type faster than the round trip and React
 * re-renders the input with the PREVIOUS param value, resetting the DOM value
 * and discarding the characters typed in between. Typing "Chiara Boni" into
 * Inventory landed `?q=i`. Not slow, not laggy: silently wrong, and only for
 * people who type quickly, which is why it survived.
 *
 * So the box is driven by local state that always echoes the keystroke, and
 * the URL follows on a pause. Returns both, because they answer different
 * questions:
 *
 *   draft  → what the seller is typing. Bind this to the input.
 *   value  → what they have settled on. Key queries off this.
 *
 * Binding a query to `draft` would fire a request per keystroke; binding the
 * input to `value` reintroduces the bug this hook exists to fix.
 *
 * An EXTERNAL param change — back/forward, a saved view, a tab switch that
 * rewrites the query string — still wins over the draft. Only the writes this
 * hook made itself are ignored, so its own echo can't clobber later typing.
 */
export function useUrlSearchInput(
  key: string,
  fallback = "",
  delayMs = SEARCH_COMMIT_MS,
): { value: string; draft: string; setDraft: (next: string) => void } {
  const [value, setValue] = useUrlParamState(key, fallback);
  const [draft, setDraft] = useState(value);
  // The last value THIS hook pushed. Anything else arriving in the param came
  // from outside and should replace what is in the box.
  const pushedRef = useRef(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (value === pushedRef.current) return;
    pushedRef.current = value;
    setDraft(value);
  }, [value]);

  // Clear on unmount so a pending commit can't navigate a page that is gone.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const onDraftChange = useCallback(
    (next: string) => {
      setDraft(next);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        // Stamp BEFORE the write, so the param change this causes is
        // recognised as ours and does not reset the box mid-word.
        pushedRef.current = next;
        setValue(next);
      }, delayMs);
    },
    [delayMs, setValue],
  );

  return { value, draft, setDraft: onDraftChange };
}
