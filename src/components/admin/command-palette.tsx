import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
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
  type LucideIcon,
} from "lucide-react";
import { edgeFetch } from "@/lib/edge-fetch";
import {
  PaletteShell,
  type PaletteSection,
} from "@/components/palette/palette-shell";
import {
  type AdminSearchGroups,
  type AdminSearchResponse,
  type AdminSearchResult,
  type AdminSearchResultType,
  ADMIN_SEARCH_GROUP_ORDER,
  emptyAdminSearchGroups,
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
//
// US-2881: this is the ADMIN MODULE now. It owns the search, the groups and
// what a row looks like; the dialog, the input, the keyboard, the ARIA and the
// empty state come from PaletteShell, shared with the seller palette. It
// gained the full combobox pattern in that move -- it had none, so an admin
// arrowing through results heard nothing announced.
//
// This module is only ever constructed here, and only AdminLayout mounts this
// component. A cross-tenant admin result cannot appear in a seller's palette
// because the seller shell never builds one.
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [serverGroups, setServerGroups] = useState<AdminSearchGroups>(
    emptyAdminSearchGroups(),
  );
  const [loading, setLoading] = useState(false);

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

  /** The shell renders these in order and skips the empty ones. */
  const sections = useMemo<PaletteSection<AdminSearchResult>[]>(
    () =>
      ADMIN_SEARCH_GROUP_ORDER.map(({ key, label }) => ({
        title: label,
        entries: groups[key] ?? [],
      })),
    [groups],
  );

  // Reset everything whenever the palette closes so it opens fresh next time.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebounced("");
      setServerGroups(emptyAdminSearchGroups());
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

  return (
    <PaletteShell
      open={open}
      onOpenChange={onOpenChange}
      title="Global admin search"
      query={query}
      onQueryChange={setQuery}
      placeholder="Search users, submissions, certificates, listings, sales, tickets, runbooks…"
      inputLabel="Global admin search"
      sections={sections}
      keyOf={(r) => `${r.type}-${r.id}`}
      onSelect={(r) => {
        onOpenChange(false);
        navigate(r.href);
      }}
      leading={
        loading ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        )
      }
      empty={
        debounced.length < 2
          ? "Type at least 2 characters to search. Try an email, SKU, certificate id, a name, or a runbook (e.g. “rollback”)."
          : loading
            ? "Searching…"
            : `No results for “${debounced}”.`
      }
      renderEntry={(result) => {
        const Icon = TYPE_ICONS[result.type];
        return (
          <>
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">{result.title}</span>
              {result.subtitle && (
                <span className="truncate text-xs text-muted-foreground">
                  {result.subtitle}
                </span>
              )}
            </span>
          </>
        );
      }}
    />
  );
}
