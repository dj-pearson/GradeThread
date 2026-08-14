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
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { supabase } from "@/lib/supabase";
import { fetchRecentSearches, recordSearch } from "@/lib/recent-searches";
import {
  SEARCH_SCOPES,
  buildSearchArgs,
  isSearchableQuery,
  mapHits,
  normalizeScope,
  type MappedHit,
  type SearchArgs,
  type SearchHit,
  type SearchScope,
} from "@/lib/flipdesk-search";

const TYPE_ICONS: Record<string, typeof Package> = {
  item: Package,
  listing: ListChecks,
  sale: DollarSign,
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
  const [debounced, setDebounced] = useState(input);
  const [results, setResults] = useState<MappedHit[]>([]);
  const [loading, setLoading] = useState(false);
  // US-2517: a failed search is not an empty search. Held apart so the UI can
  // say so instead of claiming the seller has no matching inventory.
  const [failed, setFailed] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  // US-2517: recent terms, offered when the field is empty — the same RLS-scoped
  // history the command palette and iOS GlobalSearchView already show.
  const [recent, setRecent] = useState<string[]>([]);
  // US-2517: keyboard cursor over the result list. The rows have advertised a
  // return-key affordance since day one without the key doing anything.
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

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

  // Debounce the raw input into the committed query so we don't fire an RPC on
  // every keystroke.
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(input), 250);
    return () => clearTimeout(handle);
  }, [input]);

  // Keep the URL in sync so a search is shareable and survives back/forward.
  useEffect(() => {
    const next = new URLSearchParams();
    const q = debounced.trim();
    if (q) next.set("q", q);
    if (scope !== "all") next.set("scope", scope);
    setSearchParams(next, { replace: true });
  }, [debounced, scope, setSearchParams]);

  // Run the FTS RPC whenever the committed query or scope changes. The RPC is
  // SECURITY INVOKER, so RLS scopes results to the caller — no tenant filter
  // needed here.
  useEffect(() => {
    const args = buildSearchArgs(debounced, scope);
    if (!args) {
      setResults([]);
      setFailed(false);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        // US-2517: `error` used to be dropped on the floor. supabase-js does not
        // throw on a Postgres error — it returns { data: null, error }, so a
        // dead RPC came back as zero hits and the page said "No matches". The
        // catch below almost never ran.
        const { data, error } = await (
          supabase.rpc as unknown as (
            fn: string,
            a: SearchArgs,
          ) => Promise<{ data: SearchHit[] | null; error: Error | null }>
        )("flipdesk_search", args);
        if (cancelled) return;
        if (error) {
          setFailed(true);
          setResults([]);
          return;
        }
        setFailed(false);
        setResults(mapHits(data));
      } catch {
        if (!cancelled) {
          setFailed(true);
          setResults([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debounced, scope, retryToken]);

  // Keep the keyboard cursor inside the list as results change.
  useEffect(() => {
    setActiveIdx(0);
  }, [results]);

  const searchable = isSearchableQuery(debounced);

  // US-2517: the rows show a return-key glyph, so the return key should work.
  // Up/Down move the cursor, Enter opens the row under it.
  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      const hit = results[activeIdx];
      if (!hit) return;
      e.preventDefault();
      recordSearch(debounced, scope);
      void navigate(hit.link);
    }
  }
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of results) c[r.result_type] = (c[r.result_type] ?? 0) + 1;
    return c;
  }, [results]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Search className="h-6 w-6 text-brand-red-text" />
          Search
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Search across item titles, brands, SKUs, descriptions, condition
          notes, listings, and sales. Use quotes for an exact phrase,{" "}
          <code className="rounded bg-muted px-1">-word</code> to exclude, or{" "}
          <code className="rounded bg-muted px-1">OR</code> between terms.
        </p>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder='Try: "vintage denim" -kids OR levis'
          className="pl-9"
          aria-label="Search inventory, listings and sales"
          aria-activedescendant={
            results.length > 0 ? `search-hit-${activeIdx}` : undefined
          }
        />
        {loading && (
          <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
      </div>

      <Tabs value={scope} onValueChange={(v) => setScope(v as SearchScope)}>
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
          inventory is empty. */}
      {failed && !loading ? (
        <ErrorState
          title="Search is unavailable"
          description="We couldn't run that search. Your inventory is fine — this is the search index, and it is usually temporary."
          onRetry={() => setRetryToken((t) => t + 1)}
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
      ) : results.length === 0 && !loading ? (
        <EmptyState
          icon={FileSearch}
          title="No matches"
          description={`Nothing matched “${debounced.trim()}”. Try different keywords or a broader scope.`}
        />
      ) : (
        <div className="space-y-1">
          <p className="px-1 text-xs text-muted-foreground">
            {results.length} result{results.length === 1 ? "" : "s"}
            {scope === "all" &&
              results.length > 0 &&
              ` · ${SEARCH_SCOPES.filter((s) => s.id !== "all")
                .filter((s) => counts[s.id.replace(/s$/, "")])
                .map((s) => `${counts[s.id.replace(/s$/, "")]} ${s.label.toLowerCase()}`)
                .join(", ")}`}
          </p>
          <ul className="divide-y rounded-md border" role="listbox">
            {results.map((hit, i) => (
              <li key={hit.key} id={`search-hit-${i}`} role="option" aria-selected={i === activeIdx}>
                <Link
                  to={hit.link}
                  onClick={() => recordSearch(debounced, scope)}
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
