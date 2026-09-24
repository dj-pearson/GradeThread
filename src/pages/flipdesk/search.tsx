import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import {
  Search,
  Loader2,
  Package,
  ListChecks,
  DollarSign,
  FileSearch,
  CornerDownLeft,
  Clock,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeletons";
import { fetchRecentSearches, recordSearch } from "@/lib/recent-searches";
import { useFlipdeskSearch } from "@/hooks/use-flipdesk-search";
import {
  SEARCH_SCOPES,
  isSearchableQuery,
  normalizeQuery,
  normalizeScope,
  type MappedHit,
  type SearchScope,
} from "@/lib/flipdesk-search";

const TYPE_ICONS: Record<string, typeof Package> = {
  item: Package,
  listing: ListChecks,
  sale: DollarSign,
};

const SCOPE_TYPE: Record<Exclude<SearchScope, "all">, MappedHit["result_type"]> = {
  items: "item",
  listings: "listing",
  sales: "sale",
};

function ResultIcon({ type }: { type: string }) {
  const Icon = TYPE_ICONS[type] ?? FileSearch;
  return (
    <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
  );
}

function Snippet({ hit }: { hit: MappedHit }) {
  if (hit.segments.length === 0) return null;
  return (
    <span className="block text-xs text-muted-foreground">
      {hit.segments.map((seg, i) =>
        seg.highlight ? (
          <mark key={i} className="bg-amber-200 dark:bg-amber-800/60">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </span>
  );
}

export function FlipdeskSearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [input, setInput] = useState(() => searchParams.get("q") ?? "");
  const [scope, setScope] = useState<SearchScope>(() =>
    normalizeScope(searchParams.get("scope")),
  );
  // US-2517: recent terms, offered when the field is empty — the same RLS-scoped
  // history the command palette and iOS GlobalSearchView already show.
  const [recent, setRecent] = useState<string[]>([]);
  // US-2517: keyboard cursor over the result list. The rows have advertised a
  // return-key affordance since day one without the key doing anything.
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const search = useFlipdeskSearch({ input, scope });
  const { data, isStale, isFetching, isError, flush } = search;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchRecentSearches(8).then((terms) => {
      if (!cancelled) setRecent(terms);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  function writeUrl(next: { q?: string; scope?: SearchScope }, push = false) {
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
  }

  // Keystrokes replace the history entry, once the debounce has settled.
  const { debouncedQuery } = search;
  useEffect(() => {
    writeUrl({ q: debouncedQuery });
    // writeUrl reads refs and a stable setter; only the settled text matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery]);

  function changeScope(next: SearchScope) {
    setScope(next);
    writeUrl({ scope: next }, true);
  }

  const searchable = isSearchableQuery(input);

  // F2: rows to paint. Stale rows from a wider scope are narrowed to the tab
  // that is now selected, so the first paint after a tab click is not wrong.
  const results = useMemo(() => {
    const hits = data?.hits ?? [];
    if (isStale && data?.args.p_scope === "all" && scope !== "all") {
      return hits.filter((h) => h.result_type === SCOPE_TYPE[scope]);
    }
    return hits;
  }, [data, isStale, scope]);

  // Keep the keyboard cursor inside the list as results change.
  useEffect(() => {
    setActiveIdx(0);
  }, [results]);

  function openHit(hit: MappedHit, term: string) {
    recordSearch(term, scope);
    void navigate(hit.link);
  }

  // US-2517: the rows show a return-key glyph, so the return key should work.
  // Up/Down move the cursor, Enter opens the row under it.
  async function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      if (!searchable) return;
      e.preventDefault();
      const term = normalizeQuery(input);
      // F1: a barcode wedge types the SKU and sends Enter inside the debounce.
      // The rows on screen then belong to an older prefix, so opening
      // results[activeIdx] would open the wrong garment. Resolve the current
      // text first and open ITS best row.
      if (isStale || isFetching || !data) {
        const fresh = await flush().catch(() => null);
        const first = fresh?.hits[0];
        if (first) openHit(first, term);
        return;
      }
      const hit = results[activeIdx];
      if (hit) openHit(hit, term);
      return;
    }
    if (results.length === 0 || isStale) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + results.length) % results.length);
    }
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of results) c[r.result_type] = (c[r.result_type] ?? 0) + 1;
    return c;
  }, [results]);

  const showList = searchable && !!data && !isError;
  const settledEmpty = showList && !isStale && results.length === 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        icon={Search}
        title="Search"
        subtitle={
          <>
            Search across item titles, brands, SKUs, descriptions, condition
            notes, listings, and sales. Use quotes for an exact phrase,{" "}
            <code className="rounded bg-muted px-1">-word</code> to exclude, or{" "}
            <code className="rounded bg-muted px-1">OR</code> between terms.
          </>
        }
      />

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => void handleKeyDown(e)}
          placeholder='Try: "vintage denim" -kids OR levis'
          className="pl-9"
          aria-label="Search inventory, listings and sales"
          aria-activedescendant={
            showList && results.length > 0 ? `search-hit-${activeIdx}` : undefined
          }
        />
        {searchable && isFetching && (
          <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
      </div>

      <Tabs value={scope} onValueChange={(v) => changeScope(normalizeScope(v))}>
        <TabsList>
          {SEARCH_SCOPES.map((s) => (
            <TabsTrigger key={s.id} value={s.id}>
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* US-2517: an outage says so, with a retry, instead of rendering the
          "No matches" empty state and letting the seller conclude their
          inventory is empty. F2: the order of these branches is the contract.
          Error, then nothing to search, then loading, then empty, then rows. */}
      {searchable && isError ? (
        <ErrorState
          title="Search is unavailable"
          description="We couldn't run that search. Your inventory is fine — this is the search index, and it is usually temporary."
          onRetry={() => void search.refetch()}
        />
      ) : !searchable ? (
        recent.length > 0 ? (
          <div className="space-y-1">
            <p className="px-1 text-xs font-medium text-muted-foreground">
              Recent searches
            </p>
            <ul className="divide-y rounded-md border">
              {recent.map((term) => (
                <li key={term}>
                  <button
                    type="button"
                    onClick={() => {
                      setInput(term);
                      inputRef.current?.focus();
                    }}
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-muted/60"
                  >
                    <Clock className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                    <span className="truncate">{term}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <EmptyState
            icon={Search}
            title="Search your inventory"
            description="Type at least two characters to search items, listings, and sales."
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
          description={`Nothing matched “${data.args.p_query}”. Try different keywords or a broader scope.`}
        />
      ) : (
        <div className="space-y-1">
          {!isStale && (
            <p className="px-1 text-xs text-muted-foreground">
              {results.length} result{results.length === 1 ? "" : "s"}
              {scope === "all" &&
                results.length > 0 &&
                ` · ${SEARCH_SCOPES.filter((s) => s.id !== "all")
                  .filter((s) => counts[SCOPE_TYPE[s.id as keyof typeof SCOPE_TYPE]])
                  .map((s) => `${counts[SCOPE_TYPE[s.id as keyof typeof SCOPE_TYPE]]} ${s.label.toLowerCase()}`)
                  .join(", ")}`}
            </p>
          )}
          <ul
            className={`divide-y rounded-md border ${
              isStale ? "pointer-events-none opacity-60" : ""
            }`}
            role="listbox"
            aria-busy={isStale || undefined}
          >
            {results.map((hit, i) => (
              <li key={hit.key} id={`search-hit-${i}`} role="option" aria-selected={i === activeIdx}>
                <Link
                  to={hit.link}
                  onClick={() => recordSearch(normalizeQuery(input), scope)}
                  className={`group flex items-start gap-3 px-3 py-3 hover:bg-muted/60 ${
                    i === activeIdx ? "bg-muted/60" : ""
                  }`}
                >
                  <ResultIcon type={hit.result_type} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-medium">
                        {hit.title || "Untitled"}
                      </span>
                      <Badge variant="outline" className="text-[10px]">
                        {hit.typeLabel}
                      </Badge>
                    </span>
                    <Snippet hit={hit} />
                  </span>
                  <CornerDownLeft
                    className={`mt-1 h-3 w-3 flex-shrink-0 text-muted-foreground group-hover:opacity-100 ${
                      i === activeIdx ? "opacity-100" : "opacity-0"
                    }`}
                  />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
