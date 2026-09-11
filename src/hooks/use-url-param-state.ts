import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";

type ParamsWriter = ReturnType<typeof useSearchParams>[1];

// ── US-3348: one params object per tick ─────────────────────────────────────
//
// react-router's own docs carry this warning and it is easy to read past:
// "the function callback version of setSearchParams does not support the
// queueing logic that React's setState implements. Multiple calls to
// setSearchParams in the same tick will not build on the prior value."
//
// The implementation is the reason. `setSearchParams` calls `nextInit(...)`
// with the `searchParams` captured by the render it was created in, so two
// calls in one tick are handed the SAME starting params and the second
// navigation simply overwrites the first. Nothing throws and nothing logs; one
// of the two writes just is not there afterwards. US-3207 lost a tab that way
// (a tab effect and a page reset fought, and the tab the seller had just left
// won), and it took mounting the real page to see it.
//
// So hook writes do not go through `setSearchParams` directly. They go through
// here, which keeps the params object built by the first write of a tick and
// hands it to the next write instead of a fresh copy of the render's params.
// Two different keys written in the same tick therefore both survive.
//
// The buffer lives for exactly one synchronous tick: it is cleared on a
// microtask, and it is only reused when the incoming params match the ones it
// was built from. Both guards matter. Without the base check a back-navigation
// to a URL the buffer already described would resurrect params the seller had
// just left behind.
let pendingWrite: { base: string; params: URLSearchParams } | null = null;
let pendingKeys: Map<string, string | null> | null = null;
let pendingScheduled = false;

function describeWrite(value: string | null): string {
  return value === null ? "(removed)" : JSON.stringify(value);
}

/**
 * Write one param through a buffer shared by every hook in this file.
 *
 * `mutate` edits the params in place and returns the value it left on `key`,
 * or null if it removed it. That return value is only used for the development
 * warning below.
 */
function writeParam(
  write: ParamsWriter,
  key: string,
  mutate: (params: URLSearchParams) => string | null,
): void {
  write(
    (prev) => {
      const base = prev.toString();
      const composing = pendingWrite !== null && pendingWrite.base === base;
      const params = composing ? pendingWrite!.params : new URLSearchParams(prev);
      const keys = composing && pendingKeys ? pendingKeys : new Map<string, string | null>();

      // Composing cannot rescue two writes to the SAME key: there is one slot
      // and the second value is the answer. That is the one case worth saying
      // out loud, because it is the shape that hides a real ordering bug.
      const clash = keys.has(key);
      const previous = clash ? keys.get(key) ?? null : null;

      const written = mutate(params);
      keys.set(key, written);

      if (clash && import.meta.env.DEV) {
        console.warn(
          `[useUrlParamState] "${key}" was written twice in the same tick: ` +
            `${describeWrite(previous)} then ${describeWrite(written)}. ` +
            "setSearchParams does not queue, so only the second one survives. " +
            "Compose both decisions into a single write instead.",
        );
      }

      pendingWrite = { base, params };
      pendingKeys = keys;
      if (!pendingScheduled) {
        pendingScheduled = true;
        queueMicrotask(() => {
          pendingWrite = null;
          pendingKeys = null;
          pendingScheduled = false;
        });
      }
      return params;
    },
    // Replace, not push: changing a sort five times must not put five entries
    // in browser history for the seller to walk back through.
    { replace: true },
  );
}

// URL-backed scalar state (US-958). Reads a single query param and writes it
// back with { replace: true } so updates don't pollute browser history. The
// value lives in the URL so it survives switching between the unified Inventory
// view modes (table/grid/kanban/prep) — each mode reads the same params.
//
// A value equal to `fallback` is dropped from the URL to keep it clean (the
// reader falls back to the same default).
//
// The returned setter is STABLE for the life of the component. That reads like
// a micro-optimisation and it is not; it is the whole point of the hook's
// shape. react-router builds `setSearchParams` as a `useCallback` over
// `[navigate, searchParams]`, and `searchParams` is a `useMemo` over
// `[location.search]`, so it is a NEW FUNCTION after every navigation. A setter
// built directly on it inherits that churn, and any effect listing the setter
// in its deps then fires on EVERY navigation, including the navigation the
// setter itself just caused. US-3207 is what that costs: the Inventory pager's
// criteria-reset effect listed the sibling `useUrlPageState` setter, so
// clicking Next navigated to `?page=2`, the new URL handed the effect a
// "changed" dependency, and it sent the seller back to page 1 in the same
// breath. The button was enabled, the click landed, nothing moved, and nothing
// in the code looked wrong.
//
// Holding the writer in a ref is what keeps the identity still. `fallback` is
// held the same way rather than listed in the deps, so a fallback that depends
// on props or on a flag stays live without costing the stability.
export function useUrlParamState(
  key: string,
  fallback = "",
): [string, (value: string) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const value = searchParams.get(key) ?? fallback;

  // Assigned during render, not in an effect: an effect would run AFTER the
  // effects of child components, so a write fired on the same commit would go
  // through last render's params.
  const writeRef = useRef(setSearchParams);
  writeRef.current = setSearchParams;
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;

  const setValue = useCallback(
    (next: string) => {
      writeParam(writeRef.current, key, (params) => {
        if (next === "" || next === fallbackRef.current) {
          params.delete(key);
          return null;
        }
        params.set(key, next);
        return next;
      });
    },
    [key],
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
 *
 * The returned setter is STABLE for the life of the component, and that is
 * load-bearing rather than a micro-optimisation.
 *
 * react-router's `setSearchParams` is a `useCallback` over `[navigate,
 * searchParams]`, so it is a NEW function every time the URL changes. A setter
 * built directly on it inherits that, and any effect listing the setter in its
 * deps then fires on EVERY navigation. Inventory's "reset to page 1 when the
 * criteria change" effect does list it, which is how the pager stopped working
 * entirely: clicking Next navigated to `?page=2`, the new URL handed the effect
 * a "changed" dependency, and it sent the seller straight back to page 1 in the
 * same breath. Nothing looked broken in the code; the button simply did
 * nothing. Holding the writer in a ref is what keeps the identity still.
 */
export function useUrlPageState(
  key = "page",
): [number, (next: number | ((prev: number) => number)) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const page = parsePageParam(searchParams.get(key));

  // Assigned during render, not in an effect: an effect would run AFTER the
  // effects of child components, so a reset fired on the same commit would
  // write through last render's params.
  const writeRef = useRef(setSearchParams);
  writeRef.current = setSearchParams;

  const setPage = useCallback(
    (next: number | ((prev: number) => number)) => {
      // US-3348: through the shared buffer, like every other write in this
      // file, so a page reset and a sort change landing in the same tick do not
      // eat each other. The updater also reads the CURRENT param out of the
      // params it was handed rather than closing over `page`, which is what
      // lets the setter stay stable without going stale.
      writeParam(writeRef.current, key, (params) => {
        const current = parsePageParam(params.get(key));
        const resolved = typeof next === "function" ? next(current) : next;
        const value = parsePageParam(String(Math.floor(resolved)));
        if (value === 1) {
          params.delete(key);
          return null;
        }
        params.set(key, String(value));
        return String(value);
      });
    },
    [key],
  );

  return [page, setPage];
}
