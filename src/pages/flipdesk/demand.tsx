import { Link } from "react-router";
import { Loader2, Megaphone } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { useFlipdeskDemand, type DemandFacet } from "@/hooks/use-flipdesk-demand";
import { PageHeader } from "@/components/ui/page-header";

// US-1831: seller demand signal — what buyers are actively hunting (PII-safe
// aggregate). Sellers act by sourcing/grading the wanted brand. Dataviz
// conventions: ranked horizontal bars sized by demand, emerald accent.

function FacetBars({ title, facets, max }: { title: string; facets: DemandFacet[]; max: number }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-lg">{title}</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {facets.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No demand signal yet. This fills in as buyers set alerts and search,
            so a quiet panel means nobody has asked for this lately, not that
            something is broken.
          </p>
        ) : (
          facets.map((f) => (
            <div key={f.term} className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <Link
                  to={`/dashboard/flipdesk/scout?q=${encodeURIComponent(f.term)}`}
                  className="truncate font-medium capitalize hover:underline"
                  title={`Source ${f.term}`}
                >
                  {f.term}
                </Link>
                <span className="tabular-nums text-muted-foreground">
                  {f.wantCount} want{f.wantCount === 1 ? "" : "s"}
                  {f.topMinGrade != null ? ` · ≥${f.topMinGrade}` : ""}
                  {f.topMaxPriceCents != null ? ` · ≤$${Math.round(f.topMaxPriceCents / 100)}` : ""}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-emerald-500"
                  style={{ width: `${max > 0 ? Math.round((f.wantCount / max) * 100) : 0}%` }}
                />
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

export function FlipdeskDemandPage() {
  const { demand, isLoading } = useFlipdeskDemand();

  if (isLoading) {
    return <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>;
  }
  if (!demand || demand.totalWants === 0) {
    return (
      <div className="mx-auto max-w-3xl py-8">
        <EmptyState
          icon={Megaphone}
          title="No buyer demand yet"
          description="When buyers post 'Graded Wanted' requests, the brands and categories they're hunting appear here — your cue on what to source, grade, and list."
        />
      </div>
    );
  }

  const maxBrand = Math.max(1, ...demand.brands.map((f) => f.wantCount));
  const maxCat = Math.max(1, ...demand.categories.map((f) => f.wantCount));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        icon={Megaphone}
        title="Buyer demand"
        subtitle={
          <>
            What buyers are actively hunting right now ({demand.totalWants} open
            want{demand.totalWants === 1 ? "" : "s"}). Source and grade these to
            meet demand — click a brand to scout it.
          </>
        }
      />
      <div className="grid gap-6 md:grid-cols-2">
        <FacetBars title="Top wanted brands" facets={demand.brands} max={maxBrand} />
        <FacetBars title="Top wanted categories" facets={demand.categories} max={maxCat} />
      </div>
    </div>
  );
}
