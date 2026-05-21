import { Plug } from "lucide-react";
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

const PHASE_1 = ["ebay"] as const;
const PHASE_2 = ["poshmark", "mercari", "shopify"] as const;
const PHASE_3 = ["depop", "grailed", "whatnot"] as const;

function MarketplaceCard({
  marketplace,
  phase,
}: {
  marketplace: keyof typeof MARKETPLACE_LABELS;
  phase: "Live" | "Phase 2" | "Phase 3";
}) {
  const live = phase === "Live";
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>{MARKETPLACE_LABELS[marketplace]}</CardTitle>
          <Badge variant={live ? "default" : "secondary"}>{phase}</Badge>
        </div>
        <CardDescription>Not connected</CardDescription>
      </CardHeader>
      <CardContent>
        <Button disabled className="w-full">
          {live ? "Connect" : "Available later"}
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
            OAuth connections to selling platforms. Tokens are stored
            encrypted and rotated automatically.
          </p>
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Phase 1 — eBay
        </h2>
        <div className="grid gap-4 md:grid-cols-3">
          {PHASE_1.map((m) => (
            <MarketplaceCard key={m} marketplace={m} phase="Live" />
          ))}
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
