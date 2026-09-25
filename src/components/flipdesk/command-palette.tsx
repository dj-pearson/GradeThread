import { useEffect, useMemo, useRef, useState } from "react";
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
  ArrowUpDown,
  FileSearch,
  LayoutDashboard,
  FileText,
  DollarSign,
  Settings,
  CreditCard,
  Users,
  KeyRound,
  Gift,
  Images,
  Keyboard,
  Shield,
  Star,
  History,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { fetchRecentSearches, recordSearch } from "@/lib/recent-searches";
import { useAuthStore } from "@/stores/auth-store";
import { useWorkspace } from "@/hooks/use-workspace";
import { useRecentStore } from "@/stores/recent-store";
import { ITEM_STATUS_LABELS } from "@/lib/constants";
import type { WorkspaceCapability } from "@/lib/workspace-permissions";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { OPEN_SHORTCUTS_EVENT } from "@/components/dashboard/shortcuts-help";
import type { SourceRow } from "@/types/database";
import type { ItemListRow } from "@/lib/item-list-columns";
import { itemsListQueryKey } from "@/hooks/use-items-full";
import { useFlipdeskSearch } from "@/hooks/use-flipdesk-search";
import { SEARCH_PAGE_FIELD_ATTR, type MappedHit } from "@/lib/flipdesk-search";
import { SnippetText } from "@/components/flipdesk/snippet-text";
import {
  PaletteShell,
  type PaletteSection,
} from "@/components/palette/palette-shell";
import {
  paletteMatches,
  referralPaletteActions,
  settingsPaletteActions,
} from "@/lib/settings-tabs";


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
  // Extra words that find this action ("2fa" finds Settings: Security).
  keywords?: readonly string[];
  // Only listed once something is typed, so the empty palette stays short.
  searchOnly?: boolean;
};

type Entry =
  | ActionEntry
  | { kind: "item"; id: string; item: ItemListRow }
  | { kind: "source"; id: string; source: SourceRow }
  | { kind: "submission"; id: string; sub: SubmissionLite }
  | { kind: "deep"; id: string; hit: MappedHit }
  | { kind: "recentsearch"; id: string; term: string }
  // F4: hand the term to the full Search page.
  | { kind: "seeall"; id: string; term: string };

interface Section {
  title: string;
  entries: Entry[];
}

const PER_SECTION = 8;

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

// The platform shortcut, decided once, as the header does it. A wrong glyph is
// cosmetic.
const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function CommandPalette() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  // INV-1: the list read is keyed by workspace owner, so the peek must be too.
  const ownerId = useAuthStore((s) => s.activeWorkspaceOwnerId) ?? user?.id;
  const profile = useAuthStore((s) => s.profile);
  const { can } = useWorkspace();
  // Platform admin (not the same as workspace 'admin' role) — gates the
  // admin-console quick actions below.
  const isAdmin =
    profile?.role === "admin" || profile?.role === "super_admin";
  const recentIds = useRecentStore((s) => s.recentItemIds);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [submissionHits, setSubmissionHits] = useState<SubmissionLite[]>([]);
  // US-3381: the submissions read failed. Same rule as deepFailed above: say
  // the list is short, never imply the seller has no matching submissions.
  const [subsFailed, setSubsFailed] = useState(false);
  // US-1053: per-user recent searches, offered as suggestions when the field
  // is empty. Sourced from the recent_searches RPC (RLS-scoped to the caller).
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // US-2881: Cmd/Ctrl-K through the shared hook, with allowInInput, exactly as
  // the admin shell has always done it. This used to be a hand-rolled window
  // listener whose "/" branch called isTypingTarget and whose Cmd-K branch did
  // not -- except the hook's default DOES skip typing targets, so Cmd-K inside
  // a search box opened the palette on /admin and did nothing on /dashboard.
  // One shortcut, two behaviours, and neither shell knew about the other.
  useKeyboardShortcuts([
    { key: "k", ctrlOrMeta: true, allowInInput: true, handler: () => setOpen((o) => !o) },
    // "/" stays typing-aware: it is a printable character, so opening a dialog
    // when somebody types a slash into a field would be a bug rather than a
    // shortcut.
    // On the Search page, "/" focuses that page's own field instead.
    {
      key: "/",
      handler: () => {
        if (document.querySelector(`[${SEARCH_PAGE_FIELD_ATTR}]`)) return;
        setOpen(true);
      },
    },
  ]);

  // US-2863: the header's search control opens the same dialog.
  useEffect(() => {
    function onOpenRequest() {
      setOpen(true);
    }
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenRequest);
    return () => {
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenRequest);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSubmissionHits([]);
      // F5: a failure from a previous open is not news about this one.
      setSubsFailed(false);
      // US-1053: refresh recent searches each time the palette opens.
      // US-2517: shared with the Search page rather than duplicated.
      void fetchRecentSearches(8).then((rows) =>
        setRecentSearches(rows.map((r) => r.query)),
      );
    }
  }, [open]);

  // Debounced submission search (grading side of the product). The browser
  // client is RLS-scoped, so this only ever returns the user's own rows.
  // The FlipDesk item search above covers inventory; this covers submissions.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setSubmissionHits([]);
      // F5: a search that never ran cannot have failed.
      setSubsFailed(false);
      return;
    }
    // US-3223: clearTimeout cancels a PENDING search, not one already in
    // flight. Typing on past the debounce let a slower earlier query land
    // after a faster later one, so the list showed hits for a prefix of what
    // the box said.
    let superseded = false;
    const handle = setTimeout(async () => {
      try {
        // US-3381: this catch was DEAD. A PostgrestFilterBuilder RESOLVES with
        // { data: null, error } on a 400 or an RLS refusal, it does not reject,
        // so the catch only ever fired on a network drop. Every other failure
        // emptied the Submissions section while the FlipDesk and full-text
        // sections kept showing hits, which reads as "you own no submission
        // called that" rather than as an outage.
        const { data, error } = await supabase
          .from("submissions")
          .select("id, title, brand, status")
          .ilike("title", `%${q}%`)
          .order("created_at", { ascending: false })
          .limit(6);
        if (superseded) return;
        setSubsFailed(Boolean(error));
        setSubmissionHits(error ? [] : ((data ?? []) as SubmissionLite[]));
      } catch {
        // Still reachable: a network drop rejects before the builder resolves.
        if (superseded) return;
        setSubsFailed(true);
        setSubmissionHits([]);
      }
    }, 250);
    return () => {
      superseded = true;
      clearTimeout(handle);
    };
  }, [query]);

  // Full-text search via the flipdesk_search RPC (US-144), through the same
  // cached hook the Search page uses. Searches deep text (descriptions, notes)
  // the client-side filter misses, for the active workspace only. The hook
  // debounces, drops a superseded request and caches a repeated term.
  const deep = useFlipdeskSearch({ input: query, scope: "all", limit: 8 });
  const deepSearchable = open && query.trim().length >= 2;
  const deepHits: MappedHit[] = useMemo(
    () => (deepSearchable ? deep.hits : []),
    [deepSearchable, deep.hits],
  );
  // US-2517: a failed RPC says the list is short, never that nothing matched.
  const deepFailed = deepSearchable && deep.isError;

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
  //
  // F5: these used to be read once per ownerId, so a palette mounted before the
  // list loaded kept empty Items and Recent sections for the whole session.
  // Reading on each open picks up whatever the cache holds by then.
  const items = useMemo(
    () =>
      open ? (qc.getQueryData<ItemListRow[]>(itemsListQueryKey(ownerId)) ?? []) : [],
    [qc, ownerId, open],
  );
  const sources = useMemo(
    () => (open ? (qc.getQueryData<SourceRow[]>(["sources", ownerId]) ?? []) : []),
    [qc, ownerId, open],
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
        // US-3469: one Overview with two views, so the palette names the view
        // rather than offering "Dashboard" and "Overview" as if they were two
        // places.
        kind: "action",
        id: "dashboard",
        label: "Go to Overview (Grading)",
        icon: <LayoutDashboard className="h-4 w-4" />,
        run: () => go("/dashboard?view=grading"),
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
        id: "photo-dump",
        label: "Photo dump: sort phone photos into items",
        icon: <Images className="h-4 w-4" />,
        run: () => go("/dashboard/flipdesk/money?view=reconcile&tab=photos"),
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
        label: "Go to Overview (FlipDesk)",
        icon: <Gauge className="h-4 w-4" />,
        run: () => go("/dashboard?view=flipdesk"),
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
      // One entry per Settings section, reachable by what it holds ("ship
      // from", "2fa", "ai limit") rather than only by the Settings root.
      ...settingsPaletteActions().map(
        (a): ActionEntry => ({
          kind: "action",
          id: a.id,
          label: a.label,
          icon: <Settings className="h-4 w-4" />,
          run: () => go(a.href),
          keywords: a.keywords,
          searchOnly: true,
        }),
      ),
      // The Referrals sections, reachable by "invite", "payout", "stripe"...
      ...referralPaletteActions().map(
        (a): ActionEntry => ({
          kind: "action",
          id: a.id,
          label: a.label,
          icon: <Gift className="h-4 w-4" />,
          run: () => go(a.href),
          keywords: a.keywords,
          searchOnly: true,
        }),
      ),
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

    const matchAction = availableActions.filter(
      (a) => (!a.searchOnly || q) && paletteMatches(a.label, a.keywords, q),
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

    // Deep matches from the FTS RPC. F4: only an ITEM hit can duplicate a row
    // in the Items section. A listing or sale hit whose parent item also
    // matched is a different thing (the buyer, the eBay listing) and stays.
    const shownItemIds = new Set(
      matchItems.map((e) => (e.kind === "item" ? e.item.id : "")),
    );
    const deepEntries: Entry[] = deepHits
      .filter(
        (h) => !(h.result_type === "item" && shownItemIds.has(h.result_id)),
      )
      .slice(0, PER_SECTION)
      .map((h) => ({ kind: "deep", id: h.key, hit: h }) as Entry);

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
    // F4: the palette shows the top few; the full page shows the rest. Only
    // under real results, so "No matches." and the outage copy still show.
    if (q.length >= 2 && out.length > 0) {
      out.push({
        title: "Search",
        entries: [{ kind: "seeall", id: "see-all", term: query.trim() }],
      });
    }
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

  function selectEntry(entry: Entry) {
    // US-1053: clicking a recent search re-runs it (fills the field, keeps the
    // palette open) rather than navigating anywhere.
    if (entry.kind === "recentsearch") {
      setQuery(entry.term);
      inputRef.current?.focus();
      return;
    }
    // F4: an action picked by typing "set" is not a search, so only the
    // branches that open a search result record the term.
    if (entry.kind === "action") {
      entry.run();
    } else if (entry.kind === "item") {
      void recordSearch(query);
      setOpen(false);
      navigate(`/dashboard/flipdesk/items/${entry.item.id}`);
    } else if (entry.kind === "submission") {
      void recordSearch(query);
      setOpen(false);
      navigate(`/dashboard/submissions/${entry.sub.id}`);
    } else if (entry.kind === "deep") {
      void recordSearch(query);
      setOpen(false);
      // F4: the item itself (or its listing/sale tab), not /items?focus=,
      // which redirected to an unfiltered Inventory that never read `focus`.
      navigate(entry.hit.link);
    } else if (entry.kind === "seeall") {
      setOpen(false);
      navigate(`/dashboard/flipdesk/search?q=${encodeURIComponent(entry.term)}`);
    } else {
      setOpen(false);
      navigate("/dashboard/flipdesk/sourcing?tab=sources");
    }
  }

  // US-2881: the dialog, the input, the grouping, the keyboard, the combobox
  // ARIA and the empty state all come from PaletteShell now, shared with the
  // admin palette. What stays here is the SELLER MODULE: which sections exist,
  // what a row of each kind looks like, and what selecting one does.
  const shellSections: PaletteSection<Entry>[] = sections.map((section) => ({
    title: section.title,
    entries: section.entries,
  }));

  return (
    <PaletteShell
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      query={query}
      onQueryChange={setQuery}
      placeholder="Search items, submissions, sources, actions…"
      inputLabel="Search items, submissions, sources, actions"
      sections={shellSections}
      keyOf={(entry) => `${entry.kind}-${entry.id}`}
      onSelect={selectEntry}
      leading={<Search className="h-4 w-4 text-muted-foreground" />}
      banner={
        // US-2517: an outage never poses as an empty result.
        // US-3381: the submissions read counts as one too.
        (deepFailed || subsFailed) && query ? (
          <div
            role="alert"
            className="mb-1 rounded-md bg-amber-500/10 px-3 py-2 text-xs"
          >
            {deepFailed && subsFailed
              ? "Search is having trouble right now, so these results may be incomplete."
              : deepFailed
                ? "Deep text search is unavailable right now, so these results may be incomplete."
                : "Submission search is unavailable right now, so these results may be incomplete."}
          </div>
        ) : null
      }
      empty={
        <>
          {query
            ? deepFailed || subsFailed
              ? "Search is unavailable right now. Try again in a moment."
              : "No matches."
            : "Type to search, or pick an action."}
          {/* US-2863: an outage is not a teaching moment — the examples only
              show when search is actually working. */}
          {!deepFailed && !subsFailed && (
            <ul className="mx-auto mt-4 max-w-xs space-y-1 text-left text-xs">
              {PALETTE_EXAMPLES.map((example) => (
                <li key={example} className="flex gap-2">
                  <span aria-hidden="true">&middot;</span>
                  <span>Try {example}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      }
      footer={
        <div className="flex items-center gap-3 border-t px-3 py-2 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <ArrowUpDown className="h-3 w-3" aria-hidden="true" /> navigate
          </span>
          <span>Enter to select</span>
          <span className="ml-auto">{IS_MAC ? "⌘K" : "Ctrl K"} to toggle</span>
        </div>
      }
      renderEntry={(entry) => (
        <>
          {entry.kind === "action" && (
            <>
              <span className="text-muted-foreground">{entry.icon}</span>
              <span className="flex-1">{entry.label}</span>
            </>
          )}
          {entry.kind === "item" && (
            <>
              <Package className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 truncate">{entry.item.item_title}</span>
              <Badge variant="secondary" className="text-[10px]">
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
              <span className="flex-1 truncate">{entry.source.name}</span>
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
                  {entry.hit.title || "Untitled"}
                </span>
                <SnippetText
                  segments={entry.hit.segments}
                  className="block truncate text-[11px] text-muted-foreground"
                />
              </span>
              <Badge variant="outline" className="text-[10px]">
                {entry.hit.typeLabel}
              </Badge>
            </>
          )}
          {entry.kind === "seeall" && (
            <>
              <Search className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 truncate">
                See all results for &quot;{entry.term}&quot;
              </span>
            </>
          )}
        </>
      )}
    />
  );
}
