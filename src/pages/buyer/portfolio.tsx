import { useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Lock, Plus, Shirt, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { useBuyerEntitlements } from "@/hooks/use-buyer-entitlements";
import { useBuyerCloset } from "@/hooks/use-buyer-closet";
import { useBuyerPortfolioValuation, type ItemValuation } from "@/hooks/use-buyer-portfolio-valuation";

const usd = (c: number) => `$${(c / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

// US-1826: a labeled estimate line (never fabricated precision — an unvalued
// item just shows nothing; confidence is surfaced honestly).
function EstimateLine({ v }: { v: ItemValuation | null }) {
  if (!v || v.estimate_cents == null) return null;
  const trendColor =
    v.trend === "up" ? "text-emerald-600" : v.trend === "down" ? "text-brand-red" : "text-muted-foreground";
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
    </p>
  );
}

// US-1825: closet / wardrobe portfolio. Add items you own (by certificate number
// or manually), see and manage your closet. Valuation + dashboard are US-1826/1827.
// Locked behind the wardrobePortfolio entitlement.

export function BuyerPortfolioPage() {
  const ent = useBuyerEntitlements();
  const { items, isLoading, addItem, isAdding, removeItem, isRemoving } = useBuyerCloset();
  const { totals, valuationFor } = useBuyerPortfolioValuation();

  const [certId, setCertId] = useState("");
  const [brand, setBrand] = useState("");
  const [type, setType] = useState("");
  const [size, setSize] = useState("");

  if (!ent.has("wardrobePortfolio")) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card className="flex flex-col items-center gap-4 p-10 text-center">
          <Lock className="h-8 w-8 text-muted-foreground" />
          <h1 className="text-xl font-bold">Closet Portfolio</h1>
          <p className="text-sm text-muted-foreground">
            Track what you own and its condition-adjusted value over time. This is part of a
            higher buyer plan.
          </p>
          <Button asChild>
            <Link to="/buyer/billing?upgrade=wardrobePortfolio">See plans</Link>
          </Button>
        </Card>
      </div>
    );
  }

  async function addByCert() {
    if (!certId.trim()) {
      toast.error("Enter the certificate id of a grade you own.");
      return;
    }
    try {
      await addItem({ source: "certificate", certificate_id: certId.trim() });
      toast.success("Added to your closet");
      setCertId("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't add that item.");
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
      toast.success("Added to your closet");
      setBrand("");
      setType("");
      setSize("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't add that item.");
    }
  }

  async function onRemove(id: string) {
    try {
      await removeItem(id);
      toast.success("Removed from your closet");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't remove that item.");
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2">
        <Shirt className="h-5 w-5 text-primary" />
        <h1 className="text-2xl font-bold">Closet Portfolio</h1>
      </div>

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
                    totals.unrealizedGainCents >= 0 ? "text-emerald-600" : "text-brand-red"
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
          <CardTitle className="text-lg">Add an item</CardTitle>
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
              <Input placeholder="Brand" value={brand} onChange={(e) => setBrand(e.target.value)} />
              <Input placeholder="Type" value={type} onChange={(e) => setType(e.target.value)} />
              <Input placeholder="Size" value={size} onChange={(e) => setSize(e.target.value)} />
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
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Your closet ({items.length})
        </h2>
        {isLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={Shirt}
            title="Your closet is empty"
            description="Add graded items you own or manual entries to track your wardrobe's value over time."
          />
        ) : (
          items.map((item) => (
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
                  <EstimateLine v={valuationFor(item.id)} />
                </div>
                <div className="flex items-center gap-1">
                  {item.certificate_id && (
                    <Button asChild variant="ghost" size="sm">
                      <Link to={`/cert/${item.certificate_id}`}>Grade</Link>
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove item"
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
