import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

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
