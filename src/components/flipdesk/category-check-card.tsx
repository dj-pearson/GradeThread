import { useState } from "react";
import {
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Tag,
  Search,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  useEbayCategoryCheck,
  type CategoryCheckResponse,
} from "@/hooks/use-ebay";

interface Props {
  // Local listings.id (UUID). The endpoint resolves the eBay listing
  // server-side from this — we don't need the platform_listing_id here.
  listingId: string;
}

// Shows the current eBay category the listing is in, plus a button to
// compare it against the Taxonomy API's current suggestion. Useful for
// catching listings that were filed under a suboptimal category — those
// typically lose 20-40% of search visibility on eBay.
export function CategoryCheckCard({ listingId }: Props) {
  const check = useEbayCategoryCheck();
  const [result, setResult] = useState<CategoryCheckResponse | null>(null);

  async function run() {
    try {
      const r = await check.mutateAsync({ listingId });
      setResult(r);
    } catch {
      /* error toast handled in the hook */
    }
  }

  // Initial state — no check run yet.
  if (!result && !check.isPending) {
    return (
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-3">
          <div className="flex items-center gap-2 text-sm">
            <Tag className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">
              See whether eBay would file this listing where you have filed
              it. Taxonomy is eBay's word for its category tree.
            </span>
          </div>
          <Button size="sm" variant="outline" onClick={run}>
            <Search className="mr-1.5 h-3.5 w-3.5" />
            Check category
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (check.isPending) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Asking eBay for category suggestions…
        </CardContent>
      </Card>
    );
  }

  if (!result) return null;

  const { current, suggested, match, query_used } = result;
  const top = suggested[0] ?? null;

  // Listing has no stored category — sync hasn't pulled it yet.
  if (!current) {
    return (
      <Card>
        <CardContent className="space-y-2 p-3 text-sm">
          <div className="flex items-center gap-2 text-muted-foreground">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            We don&apos;t have an eBay category stored for this listing
            yet. Run <strong>Sync from eBay</strong> to pull it.
          </div>
          {suggested.length > 0 && (
            <div className="rounded-md border bg-muted/30 p-2 text-xs">
              eBay would suggest{" "}
              <span className="font-medium text-foreground">
                {top?.path ?? top?.name}
              </span>{" "}
              for &quot;{query_used}&quot;.
            </div>
          )}
          <Button size="sm" variant="ghost" onClick={run}>
            Re-check
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (match) {
    return (
      <Card className="border-emerald-300/60 bg-emerald-50/40 dark:bg-emerald-950/20 dark:border-emerald-800/60">
        <CardContent className="space-y-1 p-3 text-sm">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            <span className="font-medium">
              In the right category
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            Listed in{" "}
            <span className="font-medium text-foreground">
              {current.name ?? current.id}
            </span>{" "}
            — that&apos;s also eBay&apos;s top suggestion for this title.
          </div>
        </CardContent>
      </Card>
    );
  }

  // Mismatch.
  return (
    <Card className="border-amber-300/60 bg-amber-50/40 dark:bg-amber-950/20 dark:border-amber-800/60">
      <CardContent className="space-y-2 p-3 text-sm">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          <span className="font-medium">Possibly wrong category</span>
        </div>
        <div className="space-y-1 text-xs">
          <div>
            <span className="text-muted-foreground">Listed in: </span>
            <span className="font-medium">{current.name ?? current.id}</span>
          </div>
          {top && (
            <div>
              <span className="text-muted-foreground">eBay suggests: </span>
              <span className="font-medium text-foreground">{top.path}</span>
            </div>
          )}
        </div>
        {suggested.length > 1 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
              Other suggestions ({suggested.length - 1})
            </summary>
            <ul className="mt-1.5 space-y-0.5 pl-4">
              {suggested.slice(1, 5).map((s) => (
                <li key={s.id}>
                  <Badge variant="outline" className="font-normal">
                    {s.path}
                  </Badge>
                </li>
              ))}
            </ul>
          </details>
        )}
        <p className="text-[11px] text-muted-foreground">
          Suggestion based on &quot;{query_used}&quot;. To switch on eBay,
          open the listing in Seller Hub and edit the category — automatic
          category updates land in a follow-up.
        </p>
      </CardContent>
    </Card>
  );
}
