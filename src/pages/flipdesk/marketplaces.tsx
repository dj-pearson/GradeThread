import { Link } from "react-router-dom";
import { Plug, ArrowRight, FileSpreadsheet } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MARKETPLACE_LABELS } from "@/lib/constants";

const PHASE_2 = ["poshmark", "mercari", "shopify"] as const;
const PHASE_3 = ["depop", "grailed", "whatnot"] as const;

function MarketplaceCard({
  marketplace,
  phase,
}: {
  marketplace: keyof typeof MARKETPLACE_LABELS;
  phase: "Phase 2" | "Phase 3";
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>{MARKETPLACE_LABELS[marketplace]}</CardTitle>
          <Badge variant="secondary">{phase}</Badge>
        </div>
        <CardDescription>Not connected</CardDescription>
      </CardHeader>
      <CardContent>
        <Button disabled className="w-full">
          Available later
        </Button>
      </CardContent>
    </Card>
  );
}

export function FlipdeskMarketplacesPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-navy text-white">
          <Plug className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Marketplaces</h1>
          <p className="text-sm text-muted-foreground">
            How FlipDesk talks to the platforms you sell on.
          </p>
        </div>
      </div>

      {/* eBay — the primary integration */}
      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Phase 1 — eBay
        </h2>
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Available now: CSV sync */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <FileSpreadsheet className="h-5 w-5" />
                  eBay — CSV sync
                </CardTitle>
                <Badge>Available now</Badge>
              </div>
              <CardDescription>
                Export the Active Listings report from eBay Seller Hub and
                upload it. FlipDesk reads each listing&apos;s{" "}
                <strong>Custom label (SKU)</strong> and matches it to your
                FlipDesk SKUs — then flags every mismatch so you can resolve
                them. No eBay developer account needed.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild className="w-full">
                <Link to="/dashboard/flipdesk/reconciliation">
                  Open SKU match
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>

          {/* Coming later: OAuth API */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>eBay — API connection</CardTitle>
                <Badge variant="secondary">Setup required</Badge>
              </div>
              <CardDescription>
                A direct OAuth connection pulls listings, pushes drafts, and
                streams payouts automatically — no CSV step. It needs an eBay
                developer account (App ID, Cert ID, Dev ID) configured in the
                edge service environment. Once those are set, the connect
                button activates.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button disabled className="w-full">
                Connect eBay account
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Phase 2 — Multi-marketplace
        </h2>
        <div className="grid gap-4 md:grid-cols-3">
          {PHASE_2.map((m) => (
            <MarketplaceCard key={m} marketplace={m} phase="Phase 2" />
          ))}
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Phase 3 — Niche
        </h2>
        <div className="grid gap-4 md:grid-cols-3">
          {PHASE_3.map((m) => (
            <MarketplaceCard key={m} marketplace={m} phase="Phase 3" />
          ))}
        </div>
      </div>
    </div>
  );
}
