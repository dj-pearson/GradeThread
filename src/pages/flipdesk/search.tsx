import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, Loader2, FileSearch, Clock, X, Lightbulb } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeletons";
import { SearchResultRow } from "@/components/flipdesk/search-result-row";
import {
  clearRecentSearches,
  fetchRecentSearches,
  recordSearch,
  removeRecentSearch,
  type RecentSearch,
} from "@/lib/recent-searches";
import { useFlipdeskSearch } from "@/hooks/use-flipdesk-search";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useAuthStore } from "@/stores/auth-store";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  SCOPE_RESULT_TYPE,
  SEARCH_PAGE_FIELD_ATTR,
  SEARCH_SCOPES,
  formatRecentAge,
  formatRecentCount,
  groupHitsByItem,
  isSearchableQuery,
  normalizeQuery,
  normalizeScope,
  summarizeHits,
  type HitGroup,
  type SearchScope,
} from "@/lib/flipdesk-search";
import type { SearchResult } from "@/lib/flipdesk-search-fetch";

const RESULTS_ID = "search-results";
const RECENTS_ID = "recent-searches";
const PAGE_JUMP = 10;

// Clickable examples for the operators websearch_to_tsquery understands.
const SEARCH_TIPS: { example: string; says: string }[] = [
  { example: '"vintage denim"', says: "Quotes find the exact phrase." },
  { example: "levis -kids", says: "A minus sign leaves a word out." },
  { example: "carhartt OR dickies", says: "OR finds either word." },
  { example: "sku:J0042", says: "sku: or bin: looks up one code." },
];

const SCOPE_LABEL = Object.fromEntries(
  SEARCH_SCOPES.map((s) => [s.id, s.label]),
) as Record<SearchScope, string>;

/** Next cursor position for a navigation key, or null if the key is not one. */
function moveCursor(key: string, idx: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
      return (idx + 1) % count;
    case "ArrowUp":
      return idx <= 0 ? count - 1 : idx - 1;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "PageDown":
      return Math.min(count - 1, Math.max(0, idx) + PAGE_JUMP);
    case "PageUp":
      return Math.max(0, idx - PAGE_JUMP);
    default:
      return null;
  }
}

export function FlipdeskSearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [input, setInput] = useState(() => searchParams.get("q") ?? "");
  const [scope, setScope] = useState<SearchScope>(() =>
    normalizeScope(searchParams.get("scope")),
  );
  // U2: the RPC stops at 50. "Show 200" raises it to the RPC's own ceiling for
  // THAT search only; a new term or tab goes back to 50 rather than every later
  // search quietly asking for four times the rows.
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const expandKey = `${scope}|${normalizeQuery(input)}`;
  const limit = expandedFor === expandKey ? MAX_LIMIT : DEFAULT_LIMIT;
  // US-2517: keyboard cursor over the result list.
  const [activeIdx, setActiveIdx] = useState(0);
  // F7: a separate cursor over recent searches. It starts on nothing, so the
  // first ArrowDown lands on the newest term.
  const [recentIdx, setRecentIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<(HTMLLIElement | null)[]>([]);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const userId = useAuthStore((s) => s.user?.id);

  const search = useFlipdeskSearch({
    input,
    scope,
    limit,
    withCovers: true,
    withExact: true,
  });
  const { data, isStale, isFetching, isError, flush } = search;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // U1: "/" puts the cursor in the field, as it does on most search pages.
  // The palette's own "/" steps aside while this field is on screen.
  useKeyboardShortcuts([
    {
      key: "/",
      handler: () => {
        inputRef.current?.focus();
        inputRef.current?.select();
      },
    },
  ]);

  // US-2517 + F7: recent terms, offered when the field is empty. The same
  // RLS-scoped history the command palette and iOS GlobalSearchView show, now
  // cached and refreshed after each search is recorded.
  const recentKey = useMemo(() => ["recent_searches", userId] as const, [userId]);
  const { data: recent = [] } = useQuery({
    queryKey: recentKey,
    queryFn: () => fetchRecentSearches(8),
    enabled: !!userId,
    staleTime: 60_000,
  });

  // F3: the URL is the source of truth for q and scope. `written` is what this
  // page last put there, so an outside change (the sidebar link, back/forward)
  // can be told apart from our own echo.
  const written = useRef({
    q: searchParams.get("q") ?? "",
    scope: normalizeScope(searchParams.get("scope")),
  });
  const urlQ = searchParams.get("q") ?? "";
  const urlScope = normalizeScope(searchParams.get("scope"));
  useEffect(() => {
    if (urlQ === written.current.q && urlScope === written.current.scope) return;
    written.current = { q: urlQ, scope: urlScope };
    setInput(urlQ);
    setScope(urlScope);
    // The outside change is a committed search, not a keystroke: skip the wait.
    void flush({ input: urlQ, scope: urlScope }).catch(() => null);
    // Only an outside URL change should run this. flush's identity changes on
    // every keystroke and must not re-trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlQ, urlScope]);

  const writeUrl = useCallback(
    (next: { q?: string; scope?: SearchScope }, push = false) => {
      const q = next.q ?? written.current.q;
      const s = next.scope ?? written.current.scope;
      if (q === written.current.q && s === written.current.scope) return;
      written.current = { q, scope: s };
      setSearchParams(
        (prev) => {
          const copy = new URLSearchParams(prev);
          if (q) copy.set("q", q);
          else copy.delete("q");
          if (s !== "all") copy.set("scope", s);
          else copy.delete("scope");
          return copy;
        },
        { replace: !push },
      );
    },
    [setSearchParams],
  );

  // Keystrokes replace the history entry, once the debounce has settled.
  const { debouncedQuery } = search;
  useEffect(() => {
    writeUrl({ q: debouncedQuery });
  }, [debouncedQuery, writeUrl]);

  function changeScope(next: SearchScope) {
    setScope(next);
    // A tab is a step Back should undo; a keystroke is not.
    writeUrl({ scope: next }, true);
  }

  const searchable = isSearchableQuery(input);

  // F2: stale rows from a wider scope are narrowed to the tab now selected, so
  // the first paint after a tab click is not wrong.
  const hits = useMemo(() => {
    const all = data?.hits ?? [];
    if (isStale && data?.args.p_scope === "all" && scope !== "all") {
      return all.filter((h) => h.result_type === SCOPE_RESULT_TYPE[scope]);
    }
    return all;
  }, [data, isStale, scope]);
  // D1: one row per garment.
  const groups = useMemo(() => groupHitsByItem(hits), [hits]);
  const summary = useMemo(
    () => summarizeHits(hits, data?.capped ?? false, limit),
    [hits, data?.capped, limit],
  );

  // Keep the keyboard cursor inside the list as results change.
  useEffect(() => {
    setActiveIdx(0);
  }, [groups]);
  useEffect(() => {
    setRecentIdx(-1);
  }, [recent, searchable]);

  // U1: the cursor never walks off screen.
  useEffect(() => {
    rowRefs.current[activeIdx]?.scrollIntoView?.({ block: "nearest" });
  }, [activeIdx]);

  function remember(term: string, result: SearchResult | undefined) {
    // A capped search is stored as the limit it ran at + 1 (51, or 201 after
    // Show 200), so it reads back as "50+" or "200+" (formatRecentCount).
    // p_limit is one more than the rows shown, except at the RPC's ceiling.
    const shown = result
      ? result.args.p_limit >= MAX_LIMIT
        ? MAX_LIMIT
        : result.args.p_limit - 1
      : DEFAULT_LIMIT;
    const resultCount = result
      ? result.capped
        ? shown + 1
        : result.hits.length
      : null;
    void recordSearch(term, {
      scope: result?.args.p_scope ?? scope,
      resultCount,
    }).then(() =>
      qc.invalidateQueries({ queryKey: recentKey }),
    );
  }

  function openGroup(
    group: HitGroup,
    term: string,
    result: SearchResult | undefined,
    e?: React.MouseEvent | React.KeyboardEvent,
  ) {
    remember(term, result);
    // The row is an option rather than a link, so honour the new-tab gesture.
    if (e && (e.metaKey || e.ctrlKey || ("button" in e && e.button === 1))) {
      window.open(group.best.link, "_blank", "noopener");
      return;
    }
    void navigate(group.best.link);
  }

  // Latest values for the stable row callbacks below.
  const openRef = useRef(openGroup);
  openRef.current = openGroup;
  const rowCtx = useRef({ input, data });
  rowCtx.current = { input, data };
  const onRowOpen = useCallback((g: HitGroup, e: React.MouseEvent | React.KeyboardEvent) => {
    openRef.current(g, normalizeQuery(rowCtx.current.input), rowCtx.current.data, e);
  }, []);
  const registerRow = useCallback((i: number, el: HTMLLIElement | null) => {
    rowRefs.current[i] = el;
  }, []);

  /** F7: run a remembered search on its own tab, with no debounce wait. */
  function runRecent(r: RecentSearch) {
    setInput(r.query);
    setScope(r.scope);
    writeUrl({ q: normalizeQuery(r.query), scope: r.scope }, true);
    void flush({ input: r.query, scope: r.scope }).catch(() => null);
    inputRef.current?.focus();
  }

  function runExample(example: string) {
    setInput(example);
    void flush({ input: example }).catch(() => null);
    inputRef.current?.focus();
  }

  function forget(r: RecentSearch) {
    if (!userId) return;
    const before = qc.getQueryData<RecentSearch[]>(recentKey) ?? [];
    qc.setQueryData<RecentSearch[]>(
      recentKey,
      before.filter((x) => x.query !== r.query),
    );
    removeRecentSearch(userId, r.query).then(
      () =>
        toast(`Removed "${r.query}" from recent searches`, {
          action: {
            label: "Undo",
            onClick: () =>
              void recordSearch(r.query, {
                scope: r.scope,
                resultCount: r.resultCount,
              }).then(() => qc.invalidateQueries({ queryKey: recentKey })),
          },
        }),
      () => {
        qc.setQueryData(recentKey, before);
        toast.error("Could not remove that search. Try again in a moment.");
      },
    );
  }

  function forgetAll() {
    if (!userId) return;
    const before = qc.getQueryData<RecentSearch[]>(recentKey) ?? [];
    qc.setQueryData<RecentSearch[]>(recentKey, []);
    clearRecentSearches(userId).then(
      () =>
        toast("Cleared recent searches", {
          action: {
            label: "Undo",
            onClick: () => {
              // Oldest first, so the newest ends up newest again.
              void [...before]
                .reverse()
                .reduce<Promise<unknown>>(
                  (p, r) =>
                    p.then(() =>
                      recordSearch(r.query, {
                        scope: r.scope,
                        resultCount: r.resultCount,
                      }),
                    ),
                  Promise.resolve(),
                )
                .then(() => qc.invalidateQueries({ queryKey: recentKey }));
            },
          },
        }),
      () => {
        qc.setQueryData(recentKey, before);
        toast.error("Could not clear recent searches. Try again in a moment.");
      },
    );
  }

  async function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // U1: Escape empties the field, then leaves it.
    if (e.key === "Escape") {
      e.preventDefault();
      if (input) setInput("");
      else inputRef.current?.blur();
      return;
    }

    // F7: with nothing to search, the cursor walks the recent searches.
    if (!searchable) {
      if (e.key === "Enter") {
        const r = recent[recentIdx];
        if (r) {
          e.preventDefault();
          runRecent(r);
        }
        return;
      }
      // F7: Delete forgets the highlighted term, so removal needs no mouse.
      if (e.key === "Delete" && recent[recentIdx]) {
        e.preventDefault();
        forget(recent[recentIdx]!);
        return;
      }
      const next = moveCursor(e.key, recentIdx, recent.length);
      if (next != null) {
        e.preventDefault();
        setRecentIdx(next);
      }
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      const term = normalizeQuery(input);
      // F1: a barcode wedge types the SKU and sends Enter inside the debounce.
      // The rows on screen then belong to an older prefix, so opening the row
      // under the cursor would open the wrong garment. Resolve the current
      // text first and open ITS best row. D2 pins an exact SKU first, so a
      // scanned tag opens its own garment.
      // Only staleness counts. A background refetch of the SAME args (window
      // focus) leaves the rows current, and the row under the cursor is the one
      // the seller chose.
      if (isStale || !data) {
        const fresh = await flush().catch(() => null);
        if (!fresh) return;
        const first = groupHitsByItem(fresh.hits)[0];
        if (first) openGroup(first, term, fresh);
        return;
      }
      const group = groups[activeIdx];
      if (group) openGroup(group, term, data);
      return;
    }
    if (isStale) return;
    const next = moveCursor(e.key, activeIdx, groups.length);
    if (next != null) {
      e.preventDefault();
      setActiveIdx(next);
    }
  }

  const showList = searchable && !!data && !isError;
  const settledEmpty = showList && !isStale && groups.length === 0;
  const listOpen = showList && groups.length > 0;
  const recentsOpen = !searchable && recent.length > 0;
  const q = data?.args.p_query ?? normalizeQuery(input);

  // U1: one polite announcement for what the list area now says.
  const liveText = !searchable
    ? ""
    : isError
      ? "Search is unavailable."
      : !data
        ? "Searching"
        : isStale
          ? ""
          : settledEmpty
            ? `Nothing matched ${q}.`
            : summary.headline;

  const activeId = listOpen
    ? `search-hit-${activeIdx}`
    : recentsOpen && recentIdx >= 0
      ? `recent-${recentIdx}`
      : undefined;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        icon={Search}
        title="Search"
        subtitle="Find any item, listing or sale."
        actions={
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm">
                <Lightbulb className="mr-1.5 h-4 w-4" aria-hidden="true" />
                Search tips
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80">
              <p className="mb-2 text-sm font-medium">Try one of these</p>
              <ul className="space-y-2">
                {SEARCH_TIPS.map((tip) => (
                  <li key={tip.example} className="text-sm">
                    <button
                      type="button"
                      onClick={() => runExample(tip.example)}
                      className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs hover:bg-muted/70"
                    >
                      {tip.example}
                    </button>{" "}
                    <span className="text-muted-foreground">{tip.says}</span>
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        }
      />

      <div className="relative">
        <Search
          aria-hidden="true"
          className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={inputRef}
          {...{ [SEARCH_PAGE_FIELD_ATTR]: "" }}
          type="search"
          role="combobox"
          aria-controls={recentsOpen ? RECENTS_ID : RESULTS_ID}
          aria-expanded={listOpen || recentsOpen}
          aria-autocomplete="list"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => void handleKeyDown(e)}
          placeholder="Brand, title, SKU or buyer"
          className="pl-9 pr-9 [&::-webkit-search-cancel-button]:hidden"
          aria-label="Search inventory, listings and sales"
          aria-activedescendant={activeId}
        />
        {searchable && isFetching ? (
          <Loader2
            aria-hidden="true"
            className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground"
          />
        ) : input ? (
          <button
            type="button"
            onClick={() => {
              setInput("");
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      <Tabs value={scope} onValueChange={(v) => changeScope(normalizeScope(v))}>
        <TabsList>
          {SEARCH_SCOPES.map((s) => (
            <TabsTrigger key={s.id} value={s.id}>
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <div aria-live="polite" className="sr-only">
          {liveText}
        </div>

        {/* One panel for whichever tab is active, so the tab's aria-controls
            points at something. The results ARE that tab's panel. */}
        <TabsContent value={scope} className="mt-6">

          {/* US-2517: an outage says so, with a retry, instead of rendering the
              "No matches" empty state and letting the seller conclude their
              inventory is empty. F2: the order of these branches is the contract.
              Error, then nothing to search, then loading, then empty, then rows. */}
          {searchable && isError ? (
            <ErrorState
              title="Search is unavailable"
              description="We could not run that search. Your items are safe. Try again in a moment."
              onRetry={() => void search.refetch()}
            />
          ) : !searchable ? (
            recentsOpen ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between px-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    Recent searches
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={forgetAll}
                  >
                    Clear
                  </Button>
                </div>
                <ul
                  id={RECENTS_ID}
                  role="listbox"
                  aria-label="Recent searches"
                  className="divide-y rounded-md border"
                >
                  {recent.map((r, i) => {
                    const count = formatRecentCount(r.resultCount);
                    const age = formatRecentAge(r.updatedAt);
                    return (
                      <li key={r.query} role="none" className="flex items-stretch">
                        <div
                          id={`recent-${i}`}
                          role="option"
                          aria-selected={i === recentIdx}
                          aria-keyshortcuts="Delete"
                          tabIndex={-1}
                          onClick={() => runRecent(r)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") runRecent(r);
                          }}
                          onMouseMove={() => setRecentIdx(i)}
                          className={`flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-3 py-2.5 text-sm ${
                            i === recentIdx
                              ? "bg-muted ring-1 ring-inset ring-primary/40"
                              : ""
                          }`}
                        >
                          <Clock
                            aria-hidden="true"
                            className="h-4 w-4 flex-shrink-0 text-muted-foreground"
                          />
                          <span className="truncate">{r.query}</span>
                          {r.scope !== "all" && (
                            <Badge variant="outline" className="text-[10px]">
                              {SCOPE_LABEL[r.scope]}
                            </Badge>
                          )}
                          <span className="ml-auto flex-shrink-0 text-xs text-muted-foreground">
                            {[count, age].filter(Boolean).join(" · ")}
                          </span>
                        </div>
                        {/* Hidden from assistive tech: a listbox may own only
                            options (axe aria-required-children). Keyboard and
                            screen-reader users remove with Delete. */}
                        <button
                          type="button"
                          tabIndex={-1}
                          aria-hidden="true"
                          onClick={() => forget(r)}
                          aria-label={`Remove ${r.query} from recent searches`}
                          className="flex w-10 flex-shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : (
              <EmptyState
                icon={Search}
                title="Search your inventory"
                description="Type two or more letters to search items, listings and sales. A SKU or a bin finds one garment."
              />
            )
          ) : !data ? (
            <LoadingRegion label="Searching">
              <SkeletonRows rows={5} />
            </LoadingRegion>
          ) : settledEmpty ? (
            <EmptyState
              icon={FileSearch}
              title="No matches"
              description={`Nothing matched "${q}". Try other words, or search All.`}
              action={
                scope !== "all"
                  ? { label: "Search All", onClick: () => changeScope("all") }
                  : undefined
              }
            />
          ) : (
            <div className="space-y-1">
              {!isStale && (
                <div className="flex flex-wrap items-center gap-x-2 px-1 text-xs text-muted-foreground">
                  <span>{summary.headline}</span>
                  {scope === "all" && summary.breakdown && (
                    <span>({summary.breakdown})</span>
                  )}
                  {data.capped && limit < MAX_LIMIT && (
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={() => setExpandedFor(expandKey)}
                    >
                      Show {MAX_LIMIT}
                    </Button>
                  )}
                </div>
              )}
              <ul
                id={RESULTS_ID}
                role="listbox"
                aria-label="Search results"
                aria-busy={isStale || undefined}
                className={`divide-y rounded-md border ${
                  isStale ? "pointer-events-none opacity-60" : ""
                }`}
              >
                {groups.map((group, i) => (
                  <SearchResultRow
                    key={group.itemId}
                    index={i}
                    group={group}
                    item={data.items.get(group.itemId)}
                    cover={data.covers.get(group.itemId)}
                    active={i === activeIdx}
                    onOpen={onRowOpen}
                    onHover={setActiveIdx}
                    registerRow={registerRow}
                  />
                ))}
              </ul>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
