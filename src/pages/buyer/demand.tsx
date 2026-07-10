import { useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Lock, Megaphone, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { useBuyerEntitlements } from "@/hooks/use-buyer-entitlements";
import { useBuyerWants } from "@/hooks/use-buyer-wants";

// US-1831: 'Graded Wanted' — post what you're hunting for and get matched to
// graded inventory. Locked behind the demandBoard entitlement.

const csv = (s: string): string[] => s.split(",").map((t) => t.trim()).filter(Boolean);
const centsFrom = (v: string): number | null => {
  const n = parseFloat(v);
  return !v.trim() || Number.isNaN(n) || n < 0 ? null : Math.round(n * 100);
};

export function BuyerDemandPage() {
  const ent = useBuyerEntitlements();
  const { wants, isLoading, createWant, isCreating, setStatus, removeWant } = useBuyerWants();

  const [brands, setBrands] = useState("");
  const [categories, setCategories] = useState("");
  const [keywords, setKeywords] = useState("");
  const [minGrade, setMinGrade] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [isPublic, setIsPublic] = useState(true);

  if (!ent.has("demandBoard")) {
    return (
      <div className="mx-auto max-w-2xl">
        <Card className="flex flex-col items-center gap-4 p-10 text-center">
          <Lock className="h-8 w-8 text-muted-foreground" />
          <h1 className="text-xl font-bold">Graded Wanted</h1>
          <p className="text-sm text-muted-foreground">
            Post what you're hunting for and get matched to graded inventory. Part of a higher buyer plan.
          </p>
          <Button asChild><Link to="/buyer/billing?upgrade=demandBoard">See plans</Link></Button>
        </Card>
      </div>
    );
  }

  async function onCreate() {
    const grade = parseFloat(minGrade);
    const input = {
      brands: csv(brands),
      categories: csv(categories),
      keywords: csv(keywords),
      min_grade: Number.isFinite(grade) ? grade : null,
      max_price_cents: centsFrom(maxPrice),
      visibility: isPublic ? ("public" as const) : ("private" as const),
    };
    if (!input.brands.length && !input.categories.length && !input.keywords.length && input.min_grade == null && input.max_price_cents == null) {
      toast.error("Add at least one criterion.");
      return;
    }
    try {
      const res = await createWant(input);
      toast.success(res.matched > 0 ? `Posted — ${res.matched} match${res.matched === 1 ? "" : "es"} already!` : "Want posted. We'll match as graded items appear.");
      setBrands(""); setCategories(""); setKeywords(""); setMinGrade(""); setMaxPrice("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not post your want.");
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-2">
        <Megaphone className="h-5 w-5 text-primary" />
        <h1 className="text-2xl font-bold">Graded Wanted</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Broadcast what you're after — sellers see the demand and we match you to graded inventory.
      </p>

      <Card>
        <CardHeader><CardTitle className="text-lg">Post a want</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="w-brands">Brands (comma-separated)</Label>
            <Input id="w-brands" placeholder="Nike, Patagonia" value={brands} onChange={(e) => setBrands(e.target.value)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="w-cats">Categories</Label>
              <Input id="w-cats" placeholder="hoodie, jacket" value={categories} onChange={(e) => setCategories(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="w-kw">Keywords</Label>
              <Input id="w-kw" placeholder="vintage, gore-tex" value={keywords} onChange={(e) => setKeywords(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="w-grade">Min grade</Label>
              <Input id="w-grade" type="number" step="0.5" min={1} max={10} placeholder="8.0" value={minGrade} onChange={(e) => setMinGrade(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="w-price">Max price (USD)</Label>
              <Input id="w-price" type="number" min={0} placeholder="60" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
            Show to sellers anonymously (helps them source it)
          </label>
          <div className="flex justify-end">
            <Button onClick={onCreate} disabled={isCreating}>
              {isCreating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              Post want
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Your wants ({wants.length})</h2>
        {isLoading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
        ) : wants.length === 0 ? (
          <EmptyState icon={Megaphone} title="No wants yet" description="Post what you're hunting for above." />
        ) : (
          wants.map((w) => (
            <Card key={w.id}>
              <CardContent className="flex items-start justify-between gap-3 py-4">
                <div className="min-w-0 space-y-1">
                  <p className="truncate text-sm font-medium">
                    {[...w.brands, ...w.categories, ...w.keywords].join(", ") || "Any item"}
                  </p>
                  <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    {w.min_grade != null && <span>grade ≥ {w.min_grade}</span>}
                    {w.max_price_cents != null && <span>· ≤ ${(w.max_price_cents / 100).toFixed(0)}</span>}
                    <Badge variant={w.visibility === "public" ? "secondary" : "outline"}>{w.visibility}</Badge>
                    {w.status !== "active" && <Badge variant="outline">{w.status}</Badge>}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {w.status === "active" && (
                    <Button variant="ghost" size="sm" onClick={() => setStatus(w.id, "expired")}>Expire</Button>
                  )}
                  <Button variant="ghost" size="icon" aria-label="Delete want" onClick={() => removeWant(w.id)}>
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
