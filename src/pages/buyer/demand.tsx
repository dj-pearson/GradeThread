import { useState } from "react";
import { Link } from "react-router";
import { ChevronDown, ChevronRight, Loader2, Megaphone, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
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
import { Checkbox } from "@/components/ui/checkbox";
import { useBuyerWants, useWantMatches } from "@/hooks/use-buyer-wants";
import { trackBuyerFeature } from "@/lib/buyer-analytics";
import { CategoryPicker } from "@/components/buyer/category-picker";

// US-1831: 'Graded Wanted' — post what you're hunting for and get matched to
// graded inventory. Locked behind the demandBoard entitlement.

const csv = (s: string): string[] => s.split(",").map((t) => t.trim()).filter(Boolean);
const centsFrom = (v: string): number | null => {
  const n = parseFloat(v);
  return !v.trim() || Number.isNaN(n) || n < 0 ? null : Math.round(n * 100);
};

export function BuyerDemandPage() {
  const ent = useBuyerEntitlements();
  const { wants, isLoading, isError, isFetching, refetch, createWant, isCreating, setStatus, removeWant } = useBuyerWants();

  const [brands, setBrands] = useState("");
  // US-2552: categories are PICKED, not typed. Matching compares them to
  // submissions.garment_category with exact equality, so "jackets" was not a
  // near miss — it was a want that could never match, and nothing said so.
  const [categories, setCategories] = useState<string[]>([]);
  const [keywords, setKeywords] = useState("");
  const [openMatches, setOpenMatches] = useState<string | null>(null);
  const [minGrade, setMinGrade] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [isPublic, setIsPublic] = useState(true);

  if (!ent.has("demandBoard")) {
    // US-2509: the shared locked state. This page used to hand-roll its
    // own card; five of them had drifted into three different button
    // treatments for the same "See plans" action.
    return (
      <BuyerPlaceholderPage
        title="Graded Wanted"
        requiresFlag="demandBoard"
        description="Post what you're hunting for and get matched to graded inventory."
      />
    );
  }

  async function onCreate() {
    const grade = parseFloat(minGrade);
    const input = {
      brands: csv(brands),
      categories,
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
      // US-1845: a want is the purest buyer-demand signal on the platform — it
      // is the seller-facing half of the flywheel, so instant matches are worth
      // carrying on the event.
      trackBuyerFeature("wants", "created", {
        visibility: input.visibility,
        matched: res.matched,
        has_grade_floor: input.min_grade != null,
      });
      toast.success(
        res.matched > 0
          ? `Posted — ${res.matched} match${res.matched === 1 ? "" : "es"} already. Open the want to see them.`
          : "Want posted. We'll match as graded items appear.",
      );
      // Anything the server refused is said out loud rather than dropped.
      if (res.ignored_categories?.length) {
        toast.warning(
          `We ignored ${res.ignored_categories.join(", ")} — we don't grade a category by that name.`,
        );
      }
      // Straight to the matches for the want just posted.
      if (res.matched > 0) setOpenMatches(res.want_id);
      setBrands(""); setCategories([]); setKeywords(""); setMinGrade(""); setMaxPrice("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not post your want.");
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        title="Graded Wanted"
        subtitle="Broadcast what you're after — sellers see the demand and we match you to graded inventory."
        icon={Megaphone}
      />

      <Card>
        <CardHeader><CardTitle className="text-lg">Post a want</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="w-brands">Brands (comma-separated)</Label>
            <Input id="w-brands" placeholder="Nike, Patagonia" value={brands} onChange={(e) => setBrands(e.target.value)} />
            <p className="text-xs text-muted-foreground">
              Matched exactly against the brand on a graded item.
            </p>
          </div>

          <CategoryPicker
            values={categories}
            onChange={setCategories}
            hint="Matched exactly against the category an item was graded under."
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="w-kw">Keywords</Label>
              <Input id="w-kw" placeholder="vintage, gore-tex" value={keywords} onChange={(e) => setKeywords(e.target.value)} />
              {/* Deliberately still free text, and NOT autocompleted: a keyword
                  is matched as a SUBSTRING of the item title and brand, so any
                  string can legitimately match and there is no set of "known
                  values" to offer. Saying what it searches is the useful part. */}
              <p className="text-xs text-muted-foreground">
                Searched inside the item title and brand.
              </p>
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
          <label htmlFor="w-public" className="flex items-center gap-2 text-sm">
            <Checkbox
              id="w-public"
              checked={isPublic}
              onCheckedChange={(v) => setIsPublic(v === true)}
            />
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
        <h2 className="text-base font-semibold text-foreground">Your wants ({wants.length})</h2>
        {isLoading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
        ) : isError ? (
          /* US-2026: a failed load must not render as an empty state — that reads as data loss, not as "retry". */
          <ErrorState
            title="Couldn't load your wants"
            description="They're still saved — we just couldn't fetch them right now."
            onRetry={() => void refetch()}
            retrying={isFetching}
          />
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
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={openMatches === w.id}
                    onClick={() => setOpenMatches(openMatches === w.id ? null : w.id)}
                  >
                    {openMatches === w.id ? (
                      <ChevronDown className="mr-1 h-4 w-4" />
                    ) : (
                      <ChevronRight className="mr-1 h-4 w-4" />
                    )}
                    Matches
                  </Button>
                  {w.status === "active" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Expire want: ${[...w.brands, ...w.categories, ...w.keywords].join(", ") || "Any item"}`}
                      onClick={() => setStatus(w.id, "expired")}
                    >
                      Expire
                    </Button>
                  )}
                  <Button variant="ghost" size="icon" aria-label={`Delete want: ${[...w.brands, ...w.categories, ...w.keywords].join(", ") || "Any item"}`} onClick={() => removeWant(w.id)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </CardContent>
              {openMatches === w.id && <WantMatches wantId={w.id} />}
            </Card>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * What a want matched (US-2552).
 *
 * Posting a want returned a count in a toast and there was no way to see what
 * it meant — then or ever, even though the matches have been recorded since
 * US-1830 and a cron notifies on new ones. Mounted only when expanded, so a
 * buyer with ten wants does not fire ten requests on arrival.
 */
function WantMatches({ wantId }: { wantId: string }) {
  const { data, isLoading, isError, refetch, isFetching } = useWantMatches(wantId);

  // Error first: react-query leaves data undefined on error, so a loading check
  // above this one would always win and this branch would never render.
  if (isError) {
    return (
      <div className="border-t px-6 py-4">
        <ErrorState
          title="Couldn't load matches"
          description="The matches are still recorded — we just could not fetch them."
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      </div>
    );
  }
  if (isLoading) {
    return (
      <div className="flex justify-center border-t py-6">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
    );
  }
  const matches = data ?? [];
  if (matches.length === 0) {
    return (
      <p className="border-t px-6 py-4 text-sm text-muted-foreground">
        Nothing has matched yet. We check as items are graded, and email you when
        one does.
      </p>
    );
  }
  return (
    <ul className="divide-y border-t">
      {matches.map((m) => (
        <li key={m.certificateId} className="flex items-center justify-between gap-3 px-6 py-3">
          <div className="min-w-0">
            <Link
              to={`/cert/${m.certificateId}`}
              className="block truncate text-sm font-medium hover:underline"
            >
              {m.title || "Graded item"}
            </Link>
            <p className="text-xs text-muted-foreground">
              {m.brand ? `${m.brand} · ` : ""}
              {m.overallScore != null ? `${m.overallScore.toFixed(1)} ${m.gradeTier ?? ""}` : "grade unavailable"}
            </p>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link to={`/cert/${m.certificateId}`}>View</Link>
          </Button>
        </li>
      ))}
    </ul>
  );
}
