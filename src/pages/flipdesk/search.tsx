import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Search,
  Loader2,
  Package,
  ListChecks,
  DollarSign,
  FileSearch,
  CornerDownLeft,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { supabase } from "@/lib/supabase";
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
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
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
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const { data } = await (
          supabase.rpc as unknown as (
            fn: string,
            a: SearchArgs,
          ) => Promise<{ data: SearchHit[] | null; error: Error | null }>
        )("flipdesk_search", args);
        if (!cancelled) setResults(mapHits(data));
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debounced, scope]);

  const searchable = isSearchableQuery(debounced);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of results) c[r.result_type] = (c[r.result_type] ?? 0) + 1;
    return c;
  }, [results]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
          <Search className="h-6 w-6 text-brand-red" />
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
          placeholder='Try: "vintage denim" -kids OR levis'
          className="pl-9"
          aria-label="Search inventory, listings and sales"
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

      {!searchable ? (
        <EmptyState
          icon={Search}
          title="Search your inventory"
          description="Type at least two characters to search items, listings, and sales."
        />
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
          <ul className="divide-y rounded-md border">
            {results.map((hit) => (
              <li key={hit.key}>
                <Link
                  to={hit.link}
                  className="group flex items-start gap-3 px-3 py-3 hover:bg-muted/60"
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
                  <CornerDownLeft className="mt-1 h-3 w-3 flex-shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
