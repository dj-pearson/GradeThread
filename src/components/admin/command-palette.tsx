import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Search,
  Loader2,
  Users,
  FileText,
  ShieldCheck,
  Tag,
  DollarSign,
  Ticket,
  BookOpen,
  CornerDownLeft,
  type LucideIcon,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { edgeFetch } from "@/lib/edge-fetch";
import { cn } from "@/lib/utils";
import {
  type AdminSearchGroups,
  type AdminSearchResponse,
  type AdminSearchResult,
  type AdminSearchResultType,
  ADMIN_SEARCH_GROUP_ORDER,
  emptyAdminSearchGroups,
  flattenAdminSearch,
} from "@/lib/admin-search";
import { searchRunbooks } from "@/lib/admin/runbooks";

const TYPE_ICONS: Record<AdminSearchResultType, LucideIcon> = {
  user: Users,
  submission: FileText,
  certificate: ShieldCheck,
  listing: Tag,
  sale: DollarSign,
  ticket: Ticket,
  runbook: BookOpen,
};

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// US-901: global admin search. Cmd/Ctrl-K opens this; type to search across
// users, submissions, certificates, listings, sales and tickets, arrow-key to
// move, Enter to jump. The query is debounced and the lookup is admin-gated +
// cross-tenant on the server (/api/admin/search). US-910 also merges the
// build-time-bundled operational runbooks (matched client-side, instantly).
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [serverGroups, setServerGroups] = useState<AdminSearchGroups>(
    emptyAdminSearchGroups(),
  );
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // US-910: runbooks are bundled in the client, so match them locally (no
  // request) and fold them into the same grouped result set.
  const runbookResults = useMemo<AdminSearchResult[]>(() => {
    if (debounced.length < 2) return [];
    return searchRunbooks(debounced).map((rb) => ({
      type: "runbook" as const,
      id: rb.slug,
      title: rb.title,
      subtitle: rb.summary,
      href: `/admin/ops/runbooks/${rb.slug}`,
      matched_on: rb.category,
    }));
  }, [debounced]);

  const groups = useMemo<AdminSearchGroups>(
    () => ({ ...serverGroups, runbooks: runbookResults }),
    [serverGroups, runbookResults],
  );

  const flat = useMemo(() => flattenAdminSearch(groups), [groups]);

  // Reset everything whenever the palette closes so it opens fresh next time.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebounced("");
      setServerGroups(emptyAdminSearchGroups());
      setActiveIndex(0);
      setLoading(false);
    }
  }, [open]);

  // Debounce the typed query (300ms) so we don't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  // Run the search whenever the debounced term changes. AbortController cancels
  // an in-flight request when the term changes again or the palette closes.
  useEffect(() => {
    if (!open) return;
    if (debounced.length < 2) {
      setServerGroups(emptyAdminSearchGroups());
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    (async () => {
      try {
        const res = await edgeFetch(
          `/api/admin/search?q=${encodeURIComponent(debounced)}`,
          { signal: controller.signal },
        );
        if (!res.ok) {
          setServerGroups(emptyAdminSearchGroups());
          return;
        }
        const json = (await res.json()) as AdminSearchResponse;
        setServerGroups(json.results ?? emptyAdminSearchGroups());
        setActiveIndex(0);
      } catch (err) {
        if ((err as Error)?.name !== "AbortError") {
          setServerGroups(emptyAdminSearchGroups());
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [debounced, open]);

  // Keep the active row clamped in range as results change.
  useEffect(() => {
    setActiveIndex((i) => (flat.length === 0 ? 0 : Math.min(i, flat.length - 1)));
  }, [flat.length]);

  function select(result: AdminSearchResult) {
    onOpenChange(false);
    navigate(result.href);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (flat.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const result = flat[activeIndex];
      if (result) select(result);
    }
  }

  // Scroll the active row into view as the user arrows through.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-result-index="${activeIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const showEmpty =
    !loading && debounced.length >= 2 && flat.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[12%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogTitle className="sr-only">Global admin search</DialogTitle>

        <div className="flex items-center gap-3 border-b px-4">
          {loading ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search users, submissions, certificates, listings, sales, tickets, runbooks…"
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            aria-label="Global admin search"
          />
        </div>

        <div ref={listRef} className="max-h-[60vh] overflow-y-auto p-2">
          {debounced.length < 2 && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              Type at least 2 characters to search. Try an email, SKU,
              certificate id, a name, or a runbook (e.g. “rollback”).
            </p>
          )}

          {showEmpty && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              No results for “{debounced}”.
            </p>
          )}

          {ADMIN_SEARCH_GROUP_ORDER.map(({ key, label }) => {
            const items = groups[key];
            if (!items || items.length === 0) return null;
            return (
              <div key={key} className="mb-1">
                <div className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {label}
                </div>
                {items.map((result) => {
                  const flatIndex = flat.indexOf(result);
                  const Icon = TYPE_ICONS[result.type];
                  const isActive = flatIndex === activeIndex;
                  return (
                    <button
                      key={`${result.type}-${result.id}`}
                      type="button"
                      data-result-index={flatIndex}
                      onClick={() => select(result)}
                      onMouseEnter={() => setActiveIndex(flatIndex)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors",
                        isActive
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-accent/50",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium">
                          {result.title}
                        </span>
                        {result.subtitle && (
                          <span className="truncate text-xs text-muted-foreground">
                            {result.subtitle}
                          </span>
                        )}
                      </span>
                      {isActive && (
                        <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
