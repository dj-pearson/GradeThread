import { useState } from "react";
import { Link } from "react-router";
import { Download, Loader2, Plus, Shirt, Store, Tag, Trash2, Video } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { BuyerPlaceholderPage } from "@/pages/buyer/placeholder";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { PageHeader } from "@/components/ui/page-header";
import { useBuyerEntitlements } from "@/hooks/use-buyer-entitlements";
import { useBuyerCloset } from "@/hooks/use-buyer-closet";
import { useBuyerPortfolioValuation, type ItemValuation } from "@/hooks/use-buyer-portfolio-valuation";
import { useBuyerTrustSignals } from "@/hooks/use-buyer-trust-signals";
import { useBuyerVideoGrades } from "@/hooks/use-buyer-video-grades";
import { TrustSignalBadges } from "@/components/buyer/trust-signals";
import { trackBuyerFeature } from "@/lib/buyer-analytics";
import type { ClosetItemRow } from "@/types/database";

const usd = (c: number) => `$${(c / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

// US-1827: best-time-to-sell guidance label + tone (dataviz colour conventions).
const GUIDANCE: Record<string, { label: string; cls: string } | undefined> = {
  sell_now: { label: "Sell now", cls: "text-emerald-600" },
  hold: { label: "Hold", cls: "text-muted-foreground" },
  watch: { label: "Watch", cls: "text-amber-600" },
};

// US-1826: a labeled estimate line (never fabricated precision — an unvalued
// item just shows nothing; confidence is surfaced honestly). `showGuidance` gates
// the US-1827 best-time-to-sell suggestion behind the analytics tier.
function EstimateLine({ v, showGuidance }: { v: ItemValuation | null; showGuidance: boolean }) {
  if (!v || v.estimate_cents == null) return null;
  const trendColor =
    v.trend === "up" ? "text-emerald-600" : v.trend === "down" ? "text-brand-red-text" : "text-muted-foreground";
  const g = showGuidance ? GUIDANCE[v.sell_guidance] : undefined;
  return (
    <p className="text-xs">
      <span className="font-semibold tabular-nums">≈ {usd(v.estimate_cents)}</span>{" "}
      <span className="text-muted-foreground">est.</span>
      {v.cost_basis_cents != null && (
        <span className={`ml-1 ${trendColor}`}>
          {v.trend === "up" ? "▲" : v.trend === "down" ? "▼" : "▬"}{" "}
          {usd(Math.abs(v.estimate_cents - v.cost_basis_cents))}
        </span>
      )}
      <span className="ml-1 text-muted-foreground">· {v.confidence} confidence</span>
      {g && <span className={`ml-1 font-medium ${g.cls}`}>· {g.label}</span>}
    </p>
  );
}

type SortKey = "added" | "value" | "gain";
type FilterKey = "all" | "gainers" | "losers";

// US-1841: send the buyer to the capture flow already in walk-around mode, with
// the closet item carried along so the finished grade is written back onto it.
function videoGradeHref(item: ClosetItemRow): string {
  const params = new URLSearchParams({ mode: "video", closet: item.id });
  return `/dashboard/submissions/new?${params.toString()}`;
}

// US-1825: closet / wardrobe portfolio. Add items you own (by certificate number
// or manually), see and manage your closet. Valuation + dashboard are US-1826/1827.
// Locked behind the wardrobePortfolio entitlement.

export function BuyerPortfolioPage() {
  const ent = useBuyerEntitlements();
  const { items, isLoading, isError, isFetching, refetch, addItem, isAdding, removeItem, isRemoving, listItem, isListing, exportCsv } =
    useBuyerCloset();
  const { totals, valuationFor } = useBuyerPortfolioValuation();
  // US-1844: coarse public trust signals for the certified items in the closet —
  // the SAME verified badges the public cert page shows, deep-linked to it.
  const { signals: trustSignals } = useBuyerTrustSignals(items.map((it) => it.certificate_id));
  // US-1841: walk-around grades this buyer asked for on their own closet items.
  const { gradeFor, isPending: isGradePending } = useBuyerVideoGrades();

  async function onExport() {
    try {
      await exportCsv();
    } catch (e) {
      toastError(e, "Export failed.");
    }
  }

  async function onList(id: string) {
    try {
      const res = await listItem(id);
      if (res.alreadyListed) {
        toast.info("Already in your FlipDesk inventory.");
      } else if (res.sellerOnboarding) {
        toast.success("Draft created! Set up FlipDesk selling to publish it.");
      } else {
        toast.success("Added to your FlipDesk inventory as a draft.");
      }
    } catch (e) {
      toastError(e, "Couldn't list this item.");
    }
  }

  const [certId, setCertId] = useState("");
  const [brand, setBrand] = useState("");
  const [type, setType] = useState("");
  const [size, setSize] = useState("");

  // US-1827: full analytics (sort/filter/guidance/alerts) is a Connoisseur benefit;
  // basic totals stay available to any portfolio-entitled buyer.
  const isAnalytics = ent.plan === "connoisseur";
  const [sortKey, setSortKey] = useState<SortKey>("added");
  const [filterKey, setFilterKey] = useState<FilterKey>("all");

  const gainOf = (id: string) => {
    const v = valuationFor(id);
    return v?.estimate_cents != null && v.cost_basis_cents != null ? v.estimate_cents - v.cost_basis_cents : null;
  };
  const displayItems = (() => {
    if (!isAnalytics) return items;
    let list = [...items];
    if (filterKey === "gainers") list = list.filter((i) => (gainOf(i.id) ?? 0) > 0);
    else if (filterKey === "losers") list = list.filter((i) => (gainOf(i.id) ?? 0) < 0);
    if (sortKey === "value") {
      list.sort((a, b) => (valuationFor(b.id)?.estimate_cents ?? -1) - (valuationFor(a.id)?.estimate_cents ?? -1));
    } else if (sortKey === "gain") {
      list.sort((a, b) => (gainOf(b.id) ?? -Infinity) - (gainOf(a.id) ?? -Infinity));
    }
    return list;
  })();

  if (!ent.has("wardrobePortfolio")) {
    // US-2509: the shared locked state. This page used to hand-roll its
    // own card; five of them had drifted into three different button
    // treatments for the same "See plans" action.
    return (
      <BuyerPlaceholderPage
        title="Closet Portfolio"
        requiresFlag="wardrobePortfolio"
        description="Track what you own and its condition-adjusted value over time."
      />
    );
  }

  async function addByCert() {
    if (!certId.trim()) {
      toast.error("Enter the certificate id of a grade you own.");
      return;
    }
    try {
      await addItem({ source: "certificate", certificate_id: certId.trim() });
      trackBuyerFeature("portfolio", "item_added", { source: "certificate" });
      toast.success("Added to your closet");
      setCertId("");
    } catch (e) {
      toastError(e, "Couldn't add that item.");
    }
  }

  async function addManual() {
    if (!brand.trim() && !type.trim()) {
      toast.error("Add at least a brand or type.");
      return;
    }
    try {
      await addItem({
        source: "manual",
        brand: brand.trim() || null,
        garment_type: type.trim() || null,
        size: size.trim() || null,
      });
      trackBuyerFeature("portfolio", "item_added", { source: "manual" });
      toast.success("Added to your closet");
      setBrand("");
      setType("");
      setSize("");
    } catch (e) {
      toastError(e, "Couldn't add that item.");
    }
  }

  async function onRemove(id: string) {
    try {
      await removeItem(id);
      toast.success("Removed from your closet");
    } catch (e) {
      toastError(e, "Couldn't remove that item.");
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="Closet Portfolio"
        icon={Shirt}
        actions={
          items.length > 0 && (
            <Button variant="outline" size="sm" onClick={onExport}>
              <Download className="mr-1.5 h-4 w-4" /> Export (insurance)
            </Button>
          )
        }
      />

      {/* US-1826: portfolio valuation summary (estimates, not appraisals). */}
      {totals && totals.itemsValued > 0 && (
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-4 py-4">
            <div>
              <p className="text-xs text-muted-foreground">Estimated value</p>
              <p className="text-2xl font-bold tabular-nums">{usd(totals.totalEstimateCents)}</p>
            </div>
            {totals.costBasisCents > 0 && (
              <div>
                <p className="text-xs text-muted-foreground">Unrealized gain/loss</p>
                <p
                  className={`text-lg font-semibold tabular-nums ${
                    totals.unrealizedGainCents >= 0 ? "text-emerald-600" : "text-brand-red-text"
                  }`}
                >
                  {totals.unrealizedGainCents >= 0 ? "+" : "−"}{usd(Math.abs(totals.unrealizedGainCents))}
                </p>
              </div>
            )}
            <p className="w-full text-[11px] text-muted-foreground">
              Estimates from linked purchase prices + GradeThread's Value Index — not a formal appraisal.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Add item</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="cert">From a grade you own (certificate id)</Label>
            <div className="flex gap-2">
              <Input id="cert" placeholder="Certificate id" value={certId} onChange={(e) => setCertId(e.target.value)} />
              <Button onClick={addByCert} disabled={isAdding} className="shrink-0">
                {isAdding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Works for grades you created or purchases you've linked in Rewards.
            </p>
          </div>

          <div className="space-y-2 border-t pt-4">
            <Label>Or add manually</Label>
            <div className="grid gap-2 sm:grid-cols-3">
              {/* US-2335: the <Label> above names the GROUP ("Or add
                  manually"), not any one field, and a placeholder stops being
                  announced on the first keystroke — so all three would go silent
                  together the moment someone starts typing. */}
              <Input aria-label="Brand" placeholder="Brand" value={brand} onChange={(e) => setBrand(e.target.value)} />
              <Input aria-label="Type" placeholder="Type" value={type} onChange={(e) => setType(e.target.value)} />
              <Input aria-label="Size" placeholder="Size" value={size} onChange={(e) => setSize(e.target.value)} />
            </div>
            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={addManual} disabled={isAdding}>
                <Plus className="mr-1.5 h-4 w-4" /> Add manual item
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-foreground">
            Your closet ({items.length})
          </h2>
          {isAnalytics ? (
            <div className="flex flex-wrap gap-1 text-xs">
              {(["added", "value", "gain"] as SortKey[]).map((k) => (
                <button
                  key={k}
                  onClick={() => setSortKey(k)}
                  className={`rounded px-2 py-1 capitalize ${sortKey === k ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
                >
                  {k === "added" ? "Newest" : k}
                </button>
              ))}
              <span className="mx-1 w-px bg-border" />
              {(["all", "gainers", "losers"] as FilterKey[]).map((k) => (
                <button
                  key={k}
                  onClick={() => setFilterKey(k)}
                  className={`rounded px-2 py-1 capitalize ${filterKey === k ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
                >
                  {k}
                </button>
              ))}
            </div>
          ) : (
            totals && totals.itemsValued > 0 && (
              <Link to="/buyer/billing?upgrade=analytics" className="text-xs text-primary underline">
                Unlock sorting, alerts &amp; sell timing
              </Link>
            )
          )}
        </div>
        {isLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : isError ? (
          /* US-2026: a failed load must NOT render as "your closet is empty".
             That told a buyer who owns 40 graded garments to add their first
             item — a false empty state reads as data loss, while a visible
             error reads as "try again". */
          <ErrorState
            title="Couldn't load your closet"
            description="Your items are safe — we just couldn't fetch them right now."
            onRetry={() => void refetch()}
            retrying={isFetching}
          />
        ) : items.length === 0 ? (
          <EmptyState
            icon={Shirt}
            title="Your closet is empty"
            description="Add graded items you own or manual entries to track your wardrobe's value over time."
          />
        ) : (
          displayItems.map((item) => (
            <Card key={item.id}>
              <CardContent className="flex items-center justify-between gap-3 py-4">
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {item.brand ? `${item.brand} ` : ""}
                    {item.title ?? item.garment_type ?? "Item"}
                  </p>
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    {item.size ? `Size ${item.size} · ` : ""}
                    {item.condition_grade != null ? `Grade ${item.condition_grade.toFixed(1)} · ` : ""}
                    <Badge variant="secondary" className="capitalize">{item.source}</Badge>
                  </p>
                  <EstimateLine v={valuationFor(item.id)} showGuidance={isAnalytics} />
                  {item.certificate_id && (
                    <TrustSignalBadges
                      certId={item.certificate_id}
                      signals={trustSignals[item.certificate_id]}
                      className="mt-1"
                    />
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {item.certificate_id && (
                    <Button asChild variant="ghost" size="sm">
                      <Link to={`/cert/${item.certificate_id}`}>Grade</Link>
                    </Button>
                  )}
                  {/* US-1841: a richer condition read before committing to a
                      higher-value purchase. Only shown when the plan includes
                      video grading — a button that always 402s is worse than an
                      upgrade line, and the pricing page already sells the tier. */}
                  {ent.has("videoGrading") && (
                    isGradePending(item.id)
                      ? (
                        <Button asChild variant="ghost" size="sm">
                          <Link to={`/dashboard/submissions/${gradeFor(item.id)?.id}`}>
                            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> Grading
                          </Link>
                        </Button>
                      )
                      : (
                        <Button asChild variant="ghost" size="sm">
                          <Link to={videoGradeHref(item)}>
                            <Video className="mr-1 h-3.5 w-3.5" /> Video grade
                          </Link>
                        </Button>
                      )
                  )}
                  {item.promoted_item_id ? (
                    <Button asChild variant="ghost" size="sm">
                      <Link to="/dashboard/flipdesk/pipeline">
                        <Store className="mr-1 h-3.5 w-3.5" /> Listed
                      </Link>
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={isListing}
                      aria-label={`List ${item.title ?? item.garment_type ?? "item"} for sale`}
                      onClick={() => onList(item.id)}
                    >
                      <Tag className="mr-1 h-3.5 w-3.5" /> List
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${item.title ?? item.garment_type ?? "item"}`}
                    onClick={() => onRemove(item.id)}
                    disabled={isRemoving}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
