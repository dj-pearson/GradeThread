import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useAuthStore } from "@/stores/auth-store";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  buildSearchArgs,
  normalizeQuery,
  searchArgsKey,
  type SearchArgs,
  type SearchScope,
} from "@/lib/flipdesk-search";
import {
  runFlipdeskSearch,
  type SearchResult,
} from "@/lib/flipdesk-search-fetch";

// One cached, typed search for the Search page and the Cmd+K palette. They used
// to build the same RPC call twice, each with its own cast, its own debounce and
// its own race handling, and the page's useState version could show hits for an
// older prefix or a "0 results" frame while a search was still running.

export const SEARCH_DEBOUNCE_MS = 250;

const NO_HITS: SearchResult["hits"] = [];

export interface UseFlipdeskSearchOptions {
  input: string;
  scope: SearchScope;
  /** Rows to show. One more is requested so a cap can be detected. */
  limit?: number;
  /** Also read a cover thumbnail per item (the page does, the palette does not). */
  withCovers?: boolean;
  debounceMs?: number;
}

export function flipdeskSearchQueryKey(
  ownerId: string | undefined,
  args: SearchArgs | null,
  withCovers: boolean,
) {
  return ["flipdesk-search", ownerId, args, withCovers] as const;
}

/** The workspace on screen: the active owner, else the caller. */
export function useSearchOwnerId(): string | undefined {
  const userId = useAuthStore((s) => s.user?.id);
  const active = useAuthStore((s) => s.activeWorkspaceOwnerId);
  return active ?? userId;
}

export function useFlipdeskSearch({
  input,
  scope,
  limit = DEFAULT_LIMIT,
  withCovers = false,
  debounceMs = SEARCH_DEBOUNCE_MS,
}: UseFlipdeskSearchOptions) {
  const ownerId = useSearchOwnerId();
  const qc = useQueryClient();
  const [debounced, setDebounced] = useState(input);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDebounced(input), debounceMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [input, debounceMs]);

  const argsFor = useCallback(
    (raw: string, sc: SearchScope): SearchArgs | null =>
      buildSearchArgs(raw, sc, Math.min(limit + 1, MAX_LIMIT)),
    [limit],
  );

  const args = useMemo(() => argsFor(debounced, scope), [argsFor, debounced, scope]);
  const liveArgs = useMemo(() => argsFor(input, scope), [argsFor, input, scope]);

  const optionsFor = useCallback(
    (a: SearchArgs | null) => ({
      queryKey: flipdeskSearchQueryKey(ownerId, a, withCovers),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        runFlipdeskSearch({
          args: a!,
          limit,
          ownerId: ownerId!,
          withCovers,
          signal,
        }),
      staleTime: 30_000,
    }),
    [ownerId, withCovers, limit],
  );

  const query = useQuery<SearchResult>({
    ...optionsFor(args),
    enabled: !!args && !!ownerId,
    placeholderData: keepPreviousData,
  });

  const data = args ? query.data : undefined;
  // Stale = the data on screen answers a different request than the one the
  // field and tabs describe right now, debounce included. A scanner that types
  // a SKU and sends Enter inside the debounce sees this as true.
  const isStale =
    !!data && searchArgsKey(data.args) !== searchArgsKey(liveArgs);

  /**
   * Skip the debounce and resolve the search for what the field says NOW.
   * Shares the in-flight request when there is one (same key). A caller that
   * has just set the field or the tab in the same tick passes the new values,
   * since this closure still holds the old ones.
   */
  const flush = useCallback(
    async (next?: {
      input?: string;
      scope?: SearchScope;
    }): Promise<SearchResult | null> => {
      if (timer.current) clearTimeout(timer.current);
      const raw = next?.input ?? input;
      setDebounced(raw);
      const a = argsFor(raw, next?.scope ?? scope);
      if (!a || !ownerId) return null;
      return qc.fetchQuery(optionsFor(a));
    },
    [argsFor, input, scope, ownerId, optionsFor, qc],
  );

  return {
    data,
    hits: data?.hits ?? NO_HITS,
    capped: data?.capped ?? false,
    /** The normalized query the current data belongs to. */
    query: data?.args.p_query ?? null,
    /** The debounced args the query is running for (null when too short). */
    args,
    isStale,
    isFetching: query.isFetching,
    isError: query.isError && !query.isFetching,
    isPending: !!args && !data,
    refetch: query.refetch,
    flush,
    /** The field's text after the debounce, normalized. */
    debouncedQuery: normalizeQuery(debounced),
  };
}
