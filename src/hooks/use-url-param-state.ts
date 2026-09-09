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

// ── US-3207: the pager, in the URL ──────────────────────────────────────────
//
// Inventory already brings back the tab, the sort, the search and the filters
// when a seller opens an item and comes back: listings-table.tsx passes
// `location.pathname + location.search` in `state.from` and item.tsx returns to
// it, so anything living in the query string survives the round trip for free.
// `page` was the one piece of that state held in `useState`, so a seller three
// pages into the Active tab landed back on page 1 after every single item.
//
// This is a separate hook rather than `useUrlParamState("page")` for two
// reasons the string version cannot serve: the value is a NUMBER with a floor,
// and the pager calls it with an updater (`p => p + 1`) that has to read the
// live param rather than a value captured on a previous render.

/**
 * A page number from a raw query param, clamped into something safe to send.
 *
 * Anything unusable becomes 1 rather than throwing. The value ends up as an
 * OFFSET in `flipdesk_listing_page`, so a negative or fractional page is not a
 * cosmetic problem — `?page=-4` would ask the server for a negative offset.
 */
export function parsePageParam(raw: string | null | undefined): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  // A page number past any real result set is harmless — the caller clamps it
  // against totalPages once the count is known — but an absurd one would build
  // an offset big enough to be its own problem.
  return Math.min(n, 100_000);
}

/**
 * Page state backed by `?page=`, with the same shape as `useState<number>`.
 *
 * Page 1 writes NO param, so the top of a list keeps a clean shareable URL and
 * every existing bookmark still means what it meant.
 */
export function useUrlPageState(
  key = "page",
): [number, (next: number | ((prev: number) => number)) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const page = parsePageParam(searchParams.get(key));

  const setPage = useCallback(
    (next: number | ((prev: number) => number)) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          // Read the CURRENT param inside the updater. Closing over `page`
          // would make two pager clicks in one tick land on the same number.
          const current = parsePageParam(params.get(key));
          const resolved = typeof next === "function" ? next(current) : next;
          const value = parsePageParam(String(Math.floor(resolved)));
          if (value === 1) params.delete(key);
          else params.set(key, String(value));
          return params;
        },
        // Replace, not push: paging five times must not put five entries in
        // browser history for the seller to walk back through.
        { replace: true },
      );
    },
    [key, setSearchParams],
  );

  return [page, setPage];
}
