import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Search,
  Package,
  MapPin,
  Plus,
  LayoutGrid,
  Gauge,
  ListChecks,
  Table2,
  Scale,
  Clock,
  CornerDownLeft,
  FileSearch,
  LayoutDashboard,
  FileText,
  DollarSign,
  Settings,
  CreditCard,
  Users,
  KeyRound,
  Gift,
  Keyboard,
  Shield,
  Star,
  History,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { fetchRecentSearches, recordSearch } from "@/lib/recent-searches";
import { useAuthStore } from "@/stores/auth-store";
import { useWorkspace } from "@/hooks/use-workspace";
import { useRecentStore } from "@/stores/recent-store";
import { ITEM_STATUS_LABELS } from "@/lib/constants";
import type { WorkspaceCapability } from "@/lib/workspace-permissions";
import { isTypingTarget } from "@/hooks/use-keyboard-shortcuts";
import { OPEN_SHORTCUTS_EVENT } from "@/components/dashboard/shortcuts-help";
import { cn } from "@/lib/utils";
import type { SourceRow } from "@/types/database";
import type { ItemListRow } from "@/lib/item-list-columns";
import { itemsListQueryKey } from "@/hooks/use-items-full";

interface SearchHit {
  result_type: string;
  result_id: string;
  inventory_item_id: string | null;
  title: string;
  snippet: string;
  rank: number;
}

// Just the columns the palette renders — kept narrow so the search query
// stays cheap.
interface SubmissionLite {
  id: string;
  title: string | null;
  brand: string | null;
  status: string;
}

type ActionEntry = {
  kind: "action";
  id: string;
  label: string;
  icon: React.ReactNode;
  run: () => void;
  // Optional workspace-capability gate — hidden when the active role can't
  // perform it (US-1074). Navigation to read surfaces stays ungated.
  requires?: WorkspaceCapability;
  // Platform-admin-only action — hidden for non-admins (US-1074).
  adminOnly?: boolean;
};

type Entry =
  | ActionEntry
  | { kind: "item"; id: string; item: ItemListRow }
  | { kind: "source"; id: string; source: SourceRow }
  | { kind: "submission"; id: string; sub: SubmissionLite }
  | { kind: "deep"; id: string; hit: SearchHit }
  | { kind: "recentsearch"; id: string; term: string };

interface Section {
  title: string;
  entries: Entry[];
}

const PER_SECTION = 8;

// Render a ts_headline snippet: highlight <mark> spans, render the rest as
// plain React text (so any raw HTML in user content is escaped, not executed).
function renderSnippet(snippet: string): ReactNode {
  const parts = snippet.split(/(<mark>.*?<\/mark>)/g);
  return parts.map((p, i) => {
    if (p.startsWith("<mark>") && p.endsWith("</mark>")) {
      return (
        <mark key={i} className="bg-amber-200 dark:bg-amber-800/60">
          {p.slice(6, -7)}
        </mark>
      );
    }
    return <span key={i}>{p}</span>;
  });
}

// US-2863: the palette was reachable only by Cmd/Ctrl-K or "/". A mouse user,
// or anyone who had not opened the shortcuts sheet, would never find the
// fastest way around a twenty-five destination app. The header dispatches this
// so a visible control can open the same dialog. Same pattern the shortcuts
// sheet already uses (OPEN_SHORTCUTS_EVENT).
export const OPEN_COMMAND_PALETTE_EVENT = "gt:open-command-palette";

// Shown under the empty state so a first-time opener sees what the box can do
// rather than a blank panel and a blinking cursor.
const PALETTE_EXAMPLES = [
  "a brand, to find every item of it",
  "a SKU or an eBay item number",
  "an action, like \"new item\" or \"connect eBay\"",
];

export function CommandPalette() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const profile = useAuthStore((s) => s.profile);
  const { can } = useWorkspace();
  // Platform admin (not the same as workspace 'admin' role) — gates the
  // admin-console quick actions below.
  const isAdmin =
    profile?.role === "admin" || profile?.role === "super_admin";
  const recentIds = useRecentStore((s) => s.recentItemIds);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const [deepHits, setDeepHits] = useState<SearchHit[]>([]);
  // US-2517: the deep-text RPC failed — say the list is short, don't imply the
  // seller owns nothing matching.
  const [deepFailed, setDeepFailed] = useState(false);
  const [submissionHits, setSubmissionHits] = useState<SubmissionLite[]>([]);
  // US-1053: per-user recent searches, offered as suggestions when the field
  // is empty. Sourced from the recent_searches RPC (RLS-scoped to the caller).
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Global open triggers: Cmd/Ctrl-K toggles; "/" opens for quick search
  // (GitHub-style) as long as the user isn't already typing in a field.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (
        e.key === "/" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !isTypingTarget(e.target)
      ) {
        e.preventDefault();
        setOpen(true);
      }
    }
    // US-2863: the header's search control opens the same dialog.
    function onOpenRequest() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenRequest);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenRequest);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      setDeepHits([]);
      setSubmissionHits([]);
      // US-1053: refresh recent searches each time the palette opens.
      // US-2517: shared with the Search page rather than duplicated.
      void fetchRecentSearches(8).then(setRecentSearches);
    }
  }, [open]);

  // Debounced submission search (grading side of the product). The browser
  // client is RLS-scoped, so this only ever returns the user's own rows.
  // The FlipDesk item search above covers inventory; this covers submissions.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setSubmissionHits([]);
      return;
    }
    const handle = setTimeout(async () => {
      try {
        const { data } = await supabase
          .from("submissions")
          .select("id, title, brand, status")
          .ilike("title", `%${q}%`)
          .order("created_at", { ascending: false })
          .limit(6);
        setSubmissionHits((data ?? []) as SubmissionLite[]);
      } catch {
        setSubmissionHits([]);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [query]);

  // Debounced full-text search via the flipdesk_search RPC (US-144).
  // Searches deep text (descriptions, notes) the client-side filter misses.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setDeepHits([]);
      return;
    }
    const handle = setTimeout(async () => {
      try {
        // US-2517: `error` was dropped here too. supabase-js resolves with
        // { data: null, error } rather than throwing, so a dead RPC silently
        // trimmed the deep-text hits and the palette looked merely thorough.
        const { data, error } = await (
          supabase.rpc as unknown as (
            fn: string,
            args: Record<string, unknown>,
          ) => Promise<{ data: SearchHit[] | null; error: Error | null }>
        )("flipdesk_search", { p_query: q, p_scope: "all", p_limit: 8 });
        setDeepFailed(Boolean(error));
        setDeepHits(error ? [] : (data ?? []));
      } catch {
        setDeepFailed(true);
        setDeepHits([]);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [query]);

  // Read whatever the app already cached — no extra round-trips. Wrapped
  // in useMemo so the references are stable for the downstream useMemo
  // that builds the entries list (otherwise it re-runs every render).
  //
  // The key must be the one a hook actually WRITES. This read used to spell
  // out `["items_full", user?.id]` by hand — the key `useItemsFull()` fills.
  // US-2188 moved every consumer to the projected `useItemsList()`, which
  // writes a DIFFERENT key, so `useItemsFull()` was left with no callers and
  // its key with no writer. Nothing errored: `getQueryData` on a key nobody
  // populates returns undefined, the `?? []` turned that into an empty list,
  // and the palette's Recent section — which exists precisely for the empty
  // search box — silently had nothing to show. Typed searches still worked,
  // via the FTS RPC below, which is why it read as fine.
  const items = useMemo(
    () => qc.getQueryData<ItemListRow[]>(itemsListQueryKey(user?.id)) ?? [],
    [qc, user?.id],
  );
  const sources = useMemo(
    () => qc.getQueryData<SourceRow[]>(["sources", user?.id]) ?? [],
    [qc, user?.id],
  );

  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };

  const actions: ActionEntry[] = useMemo(
    () => [
      {
        kind: "action",
        id: "new-submission",
        label: "New submission",
        icon: <Plus className="h-4 w-4" />,
        run: () => go("/dashboard/submissions/new"),
        requires: "submit_grade",
      },
      {
        kind: "action",
        id: "add-inventory",
        label: "Add inventory item",
        icon: <Plus className="h-4 w-4" />,
        run: () => go("/dashboard/inventory/new"),
        requires: "manage_inventory",
      },
      {
        kind: "action",
        id: "dashboard",
        label: "Go to Dashboard",
        icon: <LayoutDashboard className="h-4 w-4" />,
        run: () => go("/dashboard"),
      },
      {
        kind: "action",
        id: "submissions",
        label: "Go to Submissions",
        icon: <FileText className="h-4 w-4" />,
        run: () => go("/dashboard/submissions"),
      },
      {
        kind: "action",
        id: "inventory",
        label: "Go to Inventory",
        icon: <Package className="h-4 w-4" />,
        run: () => go("/dashboard/inventory"),
      },
      {
        kind: "action",
        id: "finances",
        label: "Go to Finances",
        icon: <DollarSign className="h-4 w-4" />,
        run: () => go("/dashboard/flipdesk/money?view=finances"),
      },
      {
        kind: "action",
        id: "settings",
        label: "Go to Settings",
        icon: <Settings className="h-4 w-4" />,
        run: () => go("/dashboard/account?tab=settings"),
      },
      {
        kind: "action",
        id: "billing",
        label: "Go to Billing",
        icon: <CreditCard className="h-4 w-4" />,
        run: () => go("/dashboard/account?tab=billing"),
        requires: "manage_billing",
      },
      {
        kind: "action",
        id: "team",
        label: "Go to Team",
        icon: <Users className="h-4 w-4" />,
        run: () => go("/dashboard/account?tab=team"),
        requires: "manage_members",
      },
      {
        kind: "action",
        id: "api-keys",
        label: "Go to API keys",
        icon: <KeyRound className="h-4 w-4" />,
        run: () => go("/dashboard/account?tab=api-keys"),
        requires: "manage_api_keys",
      },
      {
        kind: "action",
        id: "referrals",
        label: "Go to Referrals",
        icon: <Gift className="h-4 w-4" />,
        run: () => go("/dashboard/account?tab=referrals"),
      },
      {
        kind: "action",
        id: "shortcuts",
        label: "Keyboard shortcuts",
        icon: <Keyboard className="h-4 w-4" />,
        run: () => {
          setOpen(false);
          window.dispatchEvent(new CustomEvent(OPEN_SHORTCUTS_EVENT));
        },
      },
      {
        kind: "action",
        id: "intake",
        label: "Intake new item",
        icon: <Plus className="h-4 w-4" />,
        run: () => go("/dashboard/flipdesk/intake"),
        requires: "manage_inventory",
      },
      {
        kind: "action",
        id: "new-source",
        label: "New source",
        icon: <MapPin className="h-4 w-4" />,
        run: () => go("/dashboard/flipdesk/sourcing?tab=sources"),
        requires: "manage_inventory",
      },
      {
        kind: "action",
        id: "overview",
        label: "Go to Overview",
        icon: <Gauge className="h-4 w-4" />,
        run: () => go("/dashboard/flipdesk"),
      },
      {
        kind: "action",
        id: "listings",
        label: "Go to Listings",
        icon: <ListChecks className="h-4 w-4" />,
        run: () => go("/dashboard/flipdesk/inventory"),
      },
      {
        kind: "action",
        id: "items",
        label: "Go to Items",
        icon: <Table2 className="h-4 w-4" />,
        run: () => go("/dashboard/flipdesk/items"),
      },
      {
        kind: "action",
        id: "pipeline",
        label: "Go to Pipeline",
        icon: <LayoutGrid className="h-4 w-4" />,
        run: () => go("/dashboard/flipdesk/inventory?mode=kanban"),
      },
      {
        kind: "action",
        id: "reconciliation",
        label: "Go to Reconcile",
        icon: <Scale className="h-4 w-4" />,
        run: () => go("/dashboard/flipdesk/money?view=reconcile"),
      },
      // Platform-admin quick actions — filtered out for non-admins below.
      {
        kind: "action",
        id: "admin-console",
        label: "Admin: Console",
        icon: <Shield className="h-4 w-4" />,
        run: () => go("/admin"),
        adminOnly: true,
      },
      {
        kind: "action",
        id: "admin-users",
        label: "Admin: Users",
        icon: <Users className="h-4 w-4" />,
        run: () => go("/admin/users"),
        adminOnly: true,
      },
      {
        kind: "action",
        id: "admin-disputes",
        label: "Admin: Disputes",
        icon: <Scale className="h-4 w-4" />,
        run: () => go("/admin/disputes"),
        adminOnly: true,
      },
      {
        kind: "action",
        id: "admin-reviews",
        label: "Admin: Reviews",
        icon: <Star className="h-4 w-4" />,
        run: () => go("/admin/grading"),
        adminOnly: true,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Permission-scoped action list (US-1074): drop admin-only actions for
  // non-admins and capability-gated actions the active workspace role can't
  // perform. Recomputed when role/admin status changes.
  const availableActions: ActionEntry[] = useMemo(
    () =>
      actions.filter(
        (a) =>
          (!a.adminOnly || isAdmin) && (!a.requires || can(a.requires)),
      ),
    [actions, isAdmin, can],
  );

  const sections: Section[] = useMemo(() => {
    const q = query.trim().toLowerCase();

    const matchAction = availableActions.filter((a) =>
      a.label.toLowerCase().includes(q),
    );

    const matchItems: Entry[] = items
      .filter((it) => {
        if (!q) return false;
        const hay = [it.item_title, it.brand, it.item_number, it.style]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      })
      .slice(0, PER_SECTION)
      .map((it) => ({ kind: "item", id: it.id, item: it }) as Entry);

    const matchSources: Entry[] = sources
      .filter((s) => q && s.name.toLowerCase().includes(q))
      .slice(0, PER_SECTION)
      .map((s) => ({ kind: "source", id: s.id, source: s }) as Entry);

    const matchSubmissions: Entry[] = q
      ? submissionHits
          .slice(0, PER_SECTION)
          .map((s) => ({ kind: "submission", id: s.id, sub: s }) as Entry)
      : [];

    const recentEntries: Entry[] = !q
      ? recentIds
          .map((id) => items.find((it) => it.id === id))
          .filter((it): it is ItemListRow => !!it)
          .slice(0, 5)
          .map((it) => ({ kind: "item", id: it.id, item: it }) as Entry)
      : [];

    // US-1053: recent search terms — only when the field is empty, so they act
    // as a starting point rather than competing with live results.
    const recentSearchEntries: Entry[] = !q
      ? recentSearches
          .slice(0, 8)
          .map(
            (term) =>
              ({ kind: "recentsearch", id: term, term }) as Entry,
          )
      : [];

    // Deep matches from the FTS RPC — exclude items already in the Items
    // section so we don't show duplicates.
    const shownItemIds = new Set(
      matchItems.map((e) => (e.kind === "item" ? e.item.id : "")),
    );
    const deepEntries: Entry[] = deepHits
      .filter(
        (h) =>
          !(h.inventory_item_id && shownItemIds.has(h.inventory_item_id)),
      )
      .map(
        (h) =>
          ({
            kind: "deep",
            id: `${h.result_type}-${h.result_id}`,
            hit: h,
          }) as Entry,
      );

    const out: Section[] = [];
    if (recentEntries.length > 0)
      out.push({ title: "Recent", entries: recentEntries });
    if (recentSearchEntries.length > 0)
      out.push({ title: "Recent searches", entries: recentSearchEntries });
    if (matchAction.length > 0)
      out.push({ title: "Actions", entries: matchAction });
    if (matchItems.length > 0)
      out.push({ title: "Items", entries: matchItems });
    if (matchSubmissions.length > 0)
      out.push({ title: "Submissions", entries: matchSubmissions });
    if (matchSources.length > 0)
      out.push({ title: "Sources", entries: matchSources });
    if (deepEntries.length > 0)
      out.push({ title: "Full-text matches", entries: deepEntries });
    return out;
  }, [
    query,
    availableActions,
    items,
    sources,
    recentIds,
    deepHits,
    submissionHits,
    recentSearches,
  ]);

  // Flat list for keyboard navigation.
  const flat = useMemo(
    () => sections.flatMap((s) => s.entries),
    [sections],
  );

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  function selectEntry(entry: Entry) {
    // US-1053: clicking a recent search re-runs it (fills the field, keeps the
    // palette open) rather than navigating anywhere.
    if (entry.kind === "recentsearch") {
      setQuery(entry.term);
      setActiveIdx(0);
      inputRef.current?.focus();
      return;
    }
    // Persist the term the user acted on so it becomes a future suggestion.
    recordSearch(query);
    if (entry.kind === "action") {
      entry.run();
    } else if (entry.kind === "item") {
      setOpen(false);
      navigate(`/dashboard/flipdesk/items?focus=${entry.item.id}`);
    } else if (entry.kind === "submission") {
      setOpen(false);
      navigate(`/dashboard/submissions/${entry.sub.id}`);
    } else if (entry.kind === "deep") {
      setOpen(false);
      const itemId = entry.hit.inventory_item_id ?? entry.hit.result_id;
      navigate(`/dashboard/flipdesk/items?focus=${itemId}`);
    } else {
      setOpen(false);
      navigate("/dashboard/flipdesk/sourcing?tab=sources");
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(flat.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = flat[activeIdx];
      if (entry) selectEntry(entry);
    }
  }

  // Scroll the active row into view.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  let runningIdx = -1;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="max-w-xl gap-0 overflow-hidden p-0"
        onKeyDown={onKeyDown}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search items, submissions, sources, actions…"
            className="h-12 flex-1 rounded-sm bg-transparent text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            // US-441: expose the combobox pattern. The input owns the listbox
            // below; aria-activedescendant points at the arrow-key-active row so
            // a screen reader announces it without moving DOM focus off the
            // input.
            role="combobox"
            aria-label="Search items, submissions, sources, actions"
            aria-autocomplete="list"
            aria-expanded={flat.length > 0}
            aria-controls="command-palette-listbox"
            aria-activedescendant={
              flat.length > 0 ? `command-palette-option-${activeIdx}` : undefined
            }
          />
          <kbd className="rounded border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            Esc
          </kbd>
        </div>

        <div
          ref={listRef}
          id="command-palette-listbox"
          role="listbox"
          aria-label="Search results"
          className="max-h-[60dvh] overflow-y-auto p-2"
        >
          {/* US-2517: an outage never poses as an empty result. */}
          {deepFailed && query && (
            <div
              role="alert"
              className="mb-1 rounded-md bg-amber-500/10 px-3 py-2 text-xs"
            >
              Deep text search is unavailable right now, so these results may be
              incomplete.
            </div>
          )}
          {flat.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {query
                ? deepFailed
                  ? "Search is unavailable right now. Try again in a moment."
                  : "No matches."
                : "Type to search, or pick an action."}
              {/* US-2863: an outage is not a teaching moment — the examples
                  only show when search is actually working. */}
              {!deepFailed && (
                <ul className="mx-auto mt-4 max-w-xs space-y-1 text-left text-xs">
                  {PALETTE_EXAMPLES.map((example) => (
                    <li key={example} className="flex gap-2">
                      <span aria-hidden="true">&middot;</span>
                      <span>Try {example}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            sections.map((section) => (
              // US-441: each section is a labelled group inside the listbox; the
              // visual header is aria-hidden so it isn't announced twice.
              <div
                key={section.title}
                role="group"
                aria-label={section.title}
                className="mb-2"
              >
                <div
                  aria-hidden="true"
                  className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {section.title}
                </div>
                {section.entries.map((entry) => {
                  runningIdx++;
                  const idx = runningIdx;
                  const isActive = idx === activeIdx;
                  return (
                    <button
                      key={`${entry.kind}-${entry.id}`}
                      type="button"
                      id={`command-palette-option-${idx}`}
                      role="option"
                      aria-selected={isActive}
                      data-idx={idx}
                      onMouseMove={() => setActiveIdx(idx)}
                      onClick={() => selectEntry(entry)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm",
                        isActive ? "bg-muted" : "hover:bg-muted/60",
                      )}
                    >
                      {entry.kind === "action" && (
                        <>
                          <span className="text-muted-foreground">
                            {entry.icon}
                          </span>
                          <span className="flex-1">{entry.label}</span>
                        </>
                      )}
                      {entry.kind === "item" && (
                        <>
                          <Package className="h-4 w-4 text-muted-foreground" />
                          <span className="flex-1 truncate">
                            {entry.item.item_title}
                          </span>
                          <Badge
                            variant="secondary"
                            className="text-[10px]"
                          >
                            {ITEM_STATUS_LABELS[entry.item.status]}
                          </Badge>
                          {entry.item.target_price != null && (
                            <span className="font-mono text-xs tabular-nums text-muted-foreground">
                              ${entry.item.target_price.toFixed(0)}
                            </span>
                          )}
                        </>
                      )}
                      {entry.kind === "submission" && (
                        <>
                          <FileText className="h-4 w-4 text-muted-foreground" />
                          <span className="flex-1 truncate">
                            {entry.sub.title || "Untitled submission"}
                          </span>
                          <Badge variant="secondary" className="text-[10px]">
                            {entry.sub.status}
                          </Badge>
                        </>
                      )}
                      {entry.kind === "source" && (
                        <>
                          <MapPin className="h-4 w-4 text-muted-foreground" />
                          <span className="flex-1 truncate">
                            {entry.source.name}
                          </span>
                        </>
                      )}
                      {entry.kind === "recentsearch" && (
                        <>
                          <History className="h-4 w-4 text-muted-foreground" />
                          <span className="flex-1 truncate">{entry.term}</span>
                        </>
                      )}
                      {entry.kind === "deep" && (
                        <>
                          <FileSearch className="mt-0.5 h-4 w-4 flex-shrink-0 self-start text-muted-foreground" />
                          <span className="flex-1 overflow-hidden">
                            <span className="block truncate font-medium">
                              {entry.hit.title}
                            </span>
                            <span className="block truncate text-[11px] text-muted-foreground">
                              {renderSnippet(entry.hit.snippet)}
                            </span>
                          </span>
                          <Badge variant="outline" className="text-[10px]">
                            {entry.hit.result_type}
                          </Badge>
                        </>
                      )}
                      {isActive && (
                        <CornerDownLeft className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-3 border-t px-3 py-2 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" /> ↑↓ navigate
          </span>
          <span>↵ select</span>
          <span className="ml-auto">⌘K to toggle</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
