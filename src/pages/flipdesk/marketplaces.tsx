import { useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Plug,
  ArrowRight,
  FileSpreadsheet,
  Check,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
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
import { useEbayConnection, useStartEbayOauth } from "@/hooks/use-ebay";

const PHASE_2 = ["poshmark", "mercari", "shopify"] as const;
const PHASE_3 = ["depop", "grailed", "whatnot"] as const;

// User-facing copy for the result codes the OAuth callback may add to the URL.
const CALLBACK_MESSAGES: Record<
  string,
  { type: "success" | "info" | "error"; message: string }
> = {
  connected: {
    type: "success",
    message: "eBay account connected. FlipDesk can now sync listings and push drafts.",
  },
  cancelled: {
    type: "info",
    message: "eBay sign-in cancelled.",
  },
  invalid_state: {
    type: "error",
    message: "eBay sign-in expired or was tampered with. Please try again.",
  },
  state_expired: {
    type: "error",
    message: "eBay sign-in took too long and expired. Please try again.",
  },
  exchange_failed: {
    type: "error",
    message: "Could not complete eBay sign-in. Please retry, and contact support if it persists.",
  },
};

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
  const [params, setParams] = useSearchParams();
  const { data: connection, isLoading: connLoading } = useEbayConnection();
  const startOauth = useStartEbayOauth();

  // Surface the OAuth callback result once and strip it from the URL so a
  // reload doesn't re-toast.
  useEffect(() => {
    const code = params.get("ebay");
    if (!code) return;
    const entry = CALLBACK_MESSAGES[code];
    if (entry) {
      if (entry.type === "success") toast.success(entry.message);
      else if (entry.type === "info") toast.info(entry.message);
      else toast.error(entry.message);
    }
    const next = new URLSearchParams(params);
    next.delete("ebay");
    setParams(next, { replace: true });
  }, [params, setParams]);

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

          {/* OAuth API connection */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>eBay — API connection</CardTitle>
                {connection ? (
                  <Badge className="bg-emerald-600 hover:bg-emerald-600">
                    <Check className="mr-1 h-3 w-3" />
                    Connected
                  </Badge>
                ) : (
                  <Badge variant="secondary">Setup required</Badge>
                )}
              </div>
              <CardDescription>
                {connection
                  ? `Connected${
                      connection.account_handle
                        ? ` as ${connection.account_handle}`
                        : ""
                    }. FlipDesk can now sync listings, push drafts, and stream payouts automatically.`
                  : "A direct OAuth connection pulls listings, pushes drafts, and streams payouts automatically — no CSV step. Needs the edge service to be configured with eBay developer credentials."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {connLoading ? (
                <Button disabled className="w-full">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Checking…
                </Button>
              ) : connection ? (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => startOauth.mutate()}
                  disabled={startOauth.isPending}
                >
                  {startOauth.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  Reconnect
                </Button>
              ) : (
                <Button
                  className="w-full"
                  onClick={() => startOauth.mutate()}
                  disabled={startOauth.isPending}
                >
                  {startOauth.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  Connect eBay account
                </Button>
              )}
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
