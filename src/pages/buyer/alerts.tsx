import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Bell, BellRing, ExternalLink, Loader2, Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BuyerPlaceholderPage } from "@/pages/buyer/placeholder";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { ChipInput } from "@/components/buyer/chip-input";
import { CategoryPicker } from "@/components/buyer/category-picker";
import { useBuyerEntitlements } from "@/hooks/use-buyer-entitlements";
import { useBuyerPreferences } from "@/hooks/use-buyer-preferences";
import { useSavedSearches } from "@/hooks/use-saved-searches";
import { alertCapState, countActiveSearches } from "@/lib/watchlist";
import { trackBuyerFeature } from "@/lib/buyer-analytics";
import { useWatchlist } from "@/hooks/use-watchlist";
import { useBuyerAlertMatches } from "@/hooks/use-buyer-alert-matches";
import { useBuyerTrustSignals } from "@/hooks/use-buyer-trust-signals";
import { TrustSignalBadges } from "@/components/buyer/trust-signals";
import type { SavedSearchRow, WatchlistItemRow } from "@/types/database";

// US-1809: buyer alerts DELIVERY, DIGEST & MANAGEMENT UI — the dashboard that
// completes the condition-alerts epic (US-1805): manage saved searches (US-1806)
// + watchlist, tune channel/frequency (delivery via US-1803, capped by the plan
// US-1800), and see recent matches the engine (US-1807) emitted. Locked behind
// the conditionAlerts entitlement; empty/first-run states guide the first alert.

const GRADE_FLOORS: Array<{ label: string; value: number | null }> = [
  { label: "Any grade", value: null },
  { label: "6.0+ (Good)", value: 6.0 },
  { label: "7.0+ (Very Good)", value: 7.0 },
  { label: "8.0+ (Excellent)", value: 8.0 },
  { label: "9.0+ (Near-new)", value: 9.0 },
];

function dollarsFromCents(c: number | null): string {
  return c == null ? "" : String(Math.round(c) / 100);
}
function centsFromDollars(v: string): number | null {
  const n = parseFloat(v);
  if (!v.trim() || Number.isNaN(n) || n < 0) return null;
  return Math.round(n * 100);
}

// ── Saved-search editor card (owns its dirty local state) ────────────────────
function SavedSearchCard({
  search,
  onSave,
  onDelete,
  busy,
  canActivate,
}: {
  search: SavedSearchRow;
  onSave: (id: string, patch: Partial<SavedSearchRow>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  busy: boolean;
  /** False when the plan's active-alert cap is full (US-1805). */
  canActivate: boolean;
}) {
  const [label, setLabel] = useState(search.label);
  const [brands, setBrands] = useState<string[]>(search.brands);
  const [categories, setCategories] = useState<string[]>(search.categories);
  const [keywords, setKeywords] = useState<string[]>(search.keywords);
  const [minGrade, setMinGrade] = useState<number | null>(search.min_grade);
  const [maxPrice, setMaxPrice] = useState(dollarsFromCents(search.max_price_cents));

  async function save() {
    await onSave(search.id, {
      label: label.trim() || "Saved search",
      brands,
      categories,
      keywords,
      min_grade: minGrade,
      max_price_cents: centsFromDollars(maxPrice),
    });
  }

  // The alert's own name, for the controls that have no value of their own to
  // announce. Falls through to a brand or a keyword rather than to a constant:
  // an unnamed alert saves as "Saved search", so a constant here would give
  // every unnamed alert the same one.
  const alertName = label.trim() || brands[0] || keywords[0] || "unnamed alert";

  async function toggle(patch: Partial<SavedSearchRow>) {
    await onSave(search.id, patch);
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          aria-label="Alert name"
          className="max-w-xs font-medium"
        />
        <div className="flex items-center gap-3">
          <label htmlFor={`active-${search.id}`} className="flex items-center gap-2 text-sm text-muted-foreground">
            <Switch
              id={`active-${search.id}`}
              checked={search.is_active}
              // Pausing is always allowed; resuming needs room under the cap.
              disabled={!search.is_active && !canActivate}
              onCheckedChange={(v) => toggle({ is_active: v })}
            />
            {search.is_active ? "Active" : "Paused"}
          </label>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onDelete(search.id)}
            disabled={busy}
            aria-label={`Delete alert: ${alertName}`}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <ChipInput label="Brands" placeholder="e.g. Patagonia…" values={brands} onChange={setBrands} />
        {/* US-2552: a saved search matches categories by EXACT equality against
            the garment taxonomy, so free text here saved "jackets" and waited
            forever. Same picker as onboarding, settings and the demand board. */}
        <CategoryPicker values={categories} onChange={setCategories} />
        <ChipInput label="Keywords" placeholder="e.g. vintage, GORE-TEX…" values={keywords} onChange={setKeywords} />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`grade-${search.id}`}>Minimum grade</Label>
            <select
              id={`grade-${search.id}`}
              value={minGrade ?? ""}
              onChange={(e) => setMinGrade(e.target.value === "" ? null : parseFloat(e.target.value))}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {GRADE_FLOORS.map((f) => (
                <option key={f.label} value={f.value ?? ""}>{f.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`price-${search.id}`}>Max fair price (USD)</Label>
            <Input
              id={`price-${search.id}`}
              type="number"
              min={0}
              placeholder="No limit"
              value={maxPrice}
              onChange={(e) => setMaxPrice(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <div className="flex items-center gap-4">
            <label htmlFor={`email-${search.id}`} className="flex items-center gap-2 text-sm">
              <Switch
                id={`email-${search.id}`}
                checked={search.notify_email}
                onCheckedChange={(v) => toggle({ notify_email: v })}
              />
              Email
            </label>
            <label htmlFor={`push-${search.id}`} className="flex items-center gap-2 text-sm">
              <Switch
                id={`push-${search.id}`}
                checked={search.notify_push}
                onCheckedChange={(v) => toggle({ notify_push: v })}
              />
              Push
            </label>
          </div>
          <Button onClick={save} disabled={busy} size="sm">
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save changes
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function watchTargetLink(item: WatchlistItemRow): string | null {
  if (item.target_type === "certificate") return `/cert/${item.target_id}`;
  if (item.target_type === "passport") return `/passport/${item.target_id}`;
  return null; // listing links resolve later (US-1808 extension ingestion)
}

export function BuyerAlertsPage() {
  const ent = useBuyerEntitlements();
  const { preferences, save: savePrefs, isSaving: savingPrefs } = useBuyerPreferences();
  const searches = useSavedSearches();
  const watchlist = useWatchlist();
  const matches = useBuyerAlertMatches();
  // US-1844: verified badges on watched CERTIFICATE items — the same public
  // trust cues the cert page shows, so a buyer scanning their watchlist sees at a
  // glance which items are verified.
  const { signals: trustSignals } = useBuyerTrustSignals(
    watchlist.items
      .filter((it) => it.target_type === "certificate")
      .map((it) => it.target_id),
  );

  // US-1837: one-click "watch" handoff from the extension — /buyer/alerts?watch=
  // <listing url>. The tenant-scoped write happens HERE, in the buyer's authed
  // session (the extension itself never writes). Idempotent; runs once.
  const [searchParams, setSearchParams] = useSearchParams();
  const watchUrl = searchParams.get("watch");
  const [watchHandled, setWatchHandled] = useState(false);
  useEffect(() => {
    if (watchHandled || !watchUrl) return;
    setWatchHandled(true);
    watchlist
      .watch({ target_type: "listing", target_id: watchUrl.slice(0, 500), label: watchUrl.slice(0, 120) })
      .then(() => toast.success("Added to your watchlist."))
      .catch(() => toast.error("Couldn't add that to your watchlist."))
      .finally(() => {
        searchParams.delete("watch");
        setSearchParams(searchParams, { replace: true });
      });
  }, [watchUrl, watchHandled, watchlist, searchParams, setSearchParams]);

  // Local digest frequency, seeded from prefs. "immediate" is capped to a digest
  // for plans whose alertFrequency is only "daily" (the edge enforces this too).
  const canInstant = ent.config.alertFrequency !== "daily";

  // US-1805: the plan's cap on CONCURRENTLY ACTIVE saved searches. Shown and
  // respected here so the buyer sees the limit they were sold; the matching
  // engine enforces it regardless of what this screen allows.
  const alertCap = alertCapState(
    countActiveSearches(searches.searches),
    ent.config.activeAlertsCap,
  );
  const [digest, setDigest] = useState<string>("immediate");
  const [digestSeeded, setDigestSeeded] = useState(false);
  useEffect(() => {
    if (!digestSeeded && preferences) {
      setDigest(preferences.digest_frequency);
      setDigestSeeded(true);
    }
  }, [preferences, digestSeeded]);

  if (!ent.has("conditionAlerts")) {
    // US-2509: the shared locked state. This page used to hand-roll its
    // own card; five of them had drifted into three different button
    // treatments for the same "See plans" action.
    return (
      <BuyerPlaceholderPage
        title="Watchlist & Alerts"
        requiresFlag="conditionAlerts"
        description="Save searches and get alerted the moment a graded item in your brands and sizes appears."
      />
    );
  }

  async function handleDigest(next: string) {
    setDigest(next);
    try {
      await savePrefs({ digest_frequency: next as "immediate" | "daily" | "weekly" });
      toast.success("Delivery updated");
    } catch {
      toast.error("Couldn't update delivery. Please try again.");
    }
  }

  async function createSearch() {
    // A new search is created ACTIVE, so it counts against the cap immediately.
    if (alertCap.atCap) {
      // US-1845: hitting the plan cap is the upgrade moment, so it is measured
      // as its own action rather than left as a toast nobody counts.
      trackBuyerFeature("alerts", "cap_reached", { cap: alertCap.cap });
      toast.error(`Your plan runs ${alertCap.cap} active alerts. Pause one, or upgrade for more.`);
      return;
    }
    try {
      await searches.create();
      trackBuyerFeature("alerts", "created", { active_alerts: alertCap.activeCount + 1 });
      toast.success("Alert created — tune its criteria below");
    } catch {
      toast.error("Couldn't create the alert. Please try again.");
    }
  }

  async function saveSearch(id: string, patch: Partial<SavedSearchRow>) {
    if (patch.is_active === true && alertCap.atCap) {
      toast.error(`Your plan runs ${alertCap.cap} active alerts. Pause one, or upgrade for more.`);
      return;
    }
    try {
      await searches.update(id, patch);
      toast.success("Alert saved");
    } catch {
      toast.error("Couldn't save the alert. Please try again.");
    }
  }

  async function deleteSearch(id: string) {
    try {
      await searches.remove(id);
      toast.success("Alert deleted");
    } catch {
      toast.error("Couldn't delete the alert. Please try again.");
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="Watchlist & Alerts" icon={BellRing} />

      {/* Delivery / digest (US-1803 frequency, capped by plan US-1800). */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Delivery</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="digest">How often to send matches</Label>
          <select
            id="digest"
            value={digest}
            onChange={(e) => handleDigest(e.target.value)}
            disabled={savingPrefs}
            className="flex h-10 w-full max-w-xs rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="immediate" disabled={!canInstant}>
              Immediate{canInstant ? "" : " (upgrade)"}
            </option>
            <option value="daily">Daily digest</option>
            <option value="weekly">Weekly digest</option>
          </select>
          {!canInstant && (
            <p className="text-xs text-muted-foreground">
              Instant alerts are available on a higher plan — your matches arrive in a daily digest.
            </p>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="searches">
        <TabsList>
          <TabsTrigger value="searches">Saved searches</TabsTrigger>
          <TabsTrigger value="watchlist">Watchlist</TabsTrigger>
          <TabsTrigger value="matches">Recent matches</TabsTrigger>
        </TabsList>

        {/* ── Saved searches ── */}
        <TabsContent value="searches" className="space-y-4">
          {/* US-1805: the plan's active-alert allowance, stated plainly. */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              {alertCap.unlimited
                ? `${alertCap.activeCount} active ${alertCap.activeCount === 1 ? "alert" : "alerts"} — unlimited on your plan`
                : `${alertCap.activeCount} of ${alertCap.cap} active alerts used`}
              {alertCap.atCap && !alertCap.unlimited && (
                <>
                  {" · "}
                  <Link to="/buyer/billing?upgrade=conditionAlerts" className="font-medium text-primary underline-offset-4 hover:underline">
                    Upgrade for more
                  </Link>
                </>
              )}
            </p>
            <Button
              onClick={createSearch}
              disabled={searches.isMutating || alertCap.atCap}
              size="sm"
            >
              <Plus className="mr-1.5 h-4 w-4" /> New alert
            </Button>
          </div>
          {alertCap.atCap && (
            <p className="text-sm text-muted-foreground">
              You're running every alert your plan includes. Pause one to swap in a new search,
              or move up a plan to watch more at once.
            </p>
          )}
          {searches.isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : searches.isError ? (
            /* US-2026: a failed load must not render as an empty state — an
               empty alerts/watchlist screen tells the buyer their saved setup is
               GONE, which is the opposite of "try again". */
            <ErrorState
              title="Couldn't load your saved searches"
              description="Your alerts are still active — we just couldn't fetch them right now."
              onRetry={() => void searches.refetch()}
              retrying={searches.isFetching}
            />
          ) : searches.searches.length === 0 ? (
            <EmptyState
              icon={Search}
              title="No saved searches yet"
              description="Create an alert and we'll tell you the moment a matching graded item appears."
              action={{ label: "Create your first alert", onClick: createSearch, icon: Plus }}
            />
          ) : (
            searches.searches.map((s) => (
              <SavedSearchCard
                key={s.id}
                search={s}
                onSave={saveSearch}
                onDelete={deleteSearch}
                busy={searches.isMutating}
                canActivate={!alertCap.atCap}
              />
            ))
          )}
        </TabsContent>

        {/* ── Watchlist ── */}
        <TabsContent value="watchlist" className="space-y-3">
          {watchlist.isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : watchlist.isError ? (
            /* US-2026: a failed load must not render as an empty state — an
               empty alerts/watchlist screen tells the buyer their saved setup is
               GONE, which is the opposite of "try again". */
            <ErrorState
              title="Couldn't load your watchlist"
              description="The items you follow are still saved — we just couldn't fetch them right now."
              onRetry={() => void watchlist.refetch()}
              retrying={watchlist.isFetching}
            />
          ) : watchlist.items.length === 0 ? (
            <EmptyState
              icon={Bell}
              title="Your watchlist is empty"
              description="Tap “Watch” on any certificate to follow a specific item for condition and price changes."
            />
          ) : (
            watchlist.items.map((item) => {
              const link = watchTargetLink(item);
              // Matches the title the card PRINTS one line down, so the spoken
              // and printed names cannot drift. Brand is appended when there is
              // one, because "Watched item" is what an unlabelled row displays
              // and a list of them would otherwise share a name.
              const watchedName = item.label ?? item.brand ?? "Watched item";
              return (
                <Card key={item.id}>
                  <CardContent className="flex items-center justify-between gap-3 py-4">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{item.label ?? "Watched item"}</p>
                      <p className="text-xs text-muted-foreground">
                        {item.brand ? `${item.brand} · ` : ""}
                        <Badge variant="secondary" className="capitalize">{item.target_type}</Badge>
                      </p>
                      {item.target_type === "certificate" && (
                        <TrustSignalBadges
                          certId={item.target_id}
                          signals={trustSignals[item.target_id]}
                          className="mt-1"
                        />
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {link && (
                        <Button asChild variant="ghost" size="icon" aria-label={`Open ${watchedName}`}>
                          <Link to={link}><ExternalLink className="h-4 w-4" /></Link>
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${watchedName} from your watchlist`}
                        onClick={() => watchlist.unwatch(item.target_type, item.target_id)}
                        disabled={watchlist.isMutating}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </TabsContent>

        {/* ── Recent matches ── */}
        <TabsContent value="matches" className="space-y-3">
          {matches.isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : matches.isError ? (
            /* US-2026: a failed load must not render as an empty state — an
               empty alerts/watchlist screen tells the buyer their saved setup is
               GONE, which is the opposite of "try again". */
            <ErrorState
              title="Couldn't load recent matches"
              description="This is a display issue only — your alerts are still running."
              onRetry={() => void matches.refetch()}
              retrying={matches.isFetching}
            />
          ) : matches.matches.length === 0 ? (
            <EmptyState
              icon={BellRing}
              title="No matches yet"
              description="When a graded item matches one of your searches, it'll show up here — and we'll notify you."
            />
          ) : (
            matches.matches.map((m) => (
              <Card key={m.id} className={m.is_read ? undefined : "border-primary/40"}>
                <CardContent className="flex items-start justify-between gap-3 py-4">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-medium">
                      {!m.is_read && <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
                      {m.title}
                    </p>
                    <p className="text-sm text-muted-foreground">{m.message}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {new Date(m.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  {m.link && (
                    <Button
                      asChild
                      variant="outline"
                      size="sm"
                      onClick={() => { if (!m.is_read) void matches.markRead(m.id); }}
                    >
                      <Link to={m.link}>View</Link>
                    </Button>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
