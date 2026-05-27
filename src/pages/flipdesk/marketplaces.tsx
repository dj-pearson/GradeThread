import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Plug,
  ArrowRight,
  FileSpreadsheet,
  Check,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
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
import {
  useEbayConnection,
  useStartEbayOauth,
  useSyncEbayListings,
} from "@/hooks/use-ebay";

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

// Human-friendly relative timestamp for the "Last synced …" label. Falls
// back to a date string if the value is older than a week.
function formatAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "recently";
  const delta = Date.now() - t;
  const min = Math.floor(delta / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} day${day === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}

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
  const qc = useQueryClient();

  // When a background sync is running we poll last_synced_at every 5s.
  // syncSince holds the ISO timestamp right before we fired the sync so we
  // can detect when last_synced_at advances past it.
  const [syncSince, setSyncSince] = useState<string | null>(null);
  const syncToastId = useRef<string | number | null>(null);

  const pollingInterval = syncSince != null ? 5_000 : undefined;
  const { data: connection, isLoading: connLoading } = useEbayConnection(pollingInterval);
  const startOauth = useStartEbayOauth();
  const syncListings = useSyncEbayListings();

  // Detect completion: last_synced_at has moved past the moment we fired the sync.
  useEffect(() => {
    if (!syncSince || !connection?.last_synced_at) return;
    const syncedAt = new Date(connection.last_synced_at).getTime();
    const firedAt = new Date(syncSince).getTime();
    if (syncedAt > firedAt) {
      setSyncSince(null);
      if (syncToastId.current != null) {
        toast.dismiss(syncToastId.current);
        syncToastId.current = null;
      }
      qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success("eBay sync complete. Listings updated.");
    }
  }, [connection?.last_synced_at, syncSince, qc]);

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
            <CardContent className="space-y-2">
              {connLoading ? (
                <Button disabled className="w-full">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Checking…
                </Button>
              ) : connection ? (
                <>
                  <Button
                    className="w-full"
                    onClick={async () => {
                      try {
                        const firedAt = new Date().toISOString();
                        const r = await syncListings.mutateAsync();

                        if (r.started) {
                          // 202 — sync is running in the background.
                          // Start polling; show a persistent toast until done.
                          setSyncSince(firedAt);
                          syncToastId.current = toast.loading(
                            "eBay sync running in background…",
                            {
                              description:
                                "Listings and sales will update automatically when done.",
                              duration: Infinity,
                            },
                          );
                          return;
                        }

                        // 200 — sync completed synchronously (shouldn't happen
                        // after the 202 change, but handle gracefully).
                        const totalMatched = (r.matched ?? 0) + (r.legacy_matched ?? 0);
                        const legacyLine = (r.legacy_matched ?? 0) > 0
                          ? ` (${r.legacy_matched} legacy)`
                          : "";
                        const salesLine = (r.sales_new ?? 0) + (r.sales_updated ?? 0) > 0
                          ? ` • ${r.sales_new} new sale${r.sales_new === 1 ? "" : "s"}${(r.sales_updated ?? 0) > 0 ? `, ${r.sales_updated} updated` : ""}`
                          : "";
                        const totalUnmatched = (r.unmatched ?? 0) + (r.legacy_unmatched ?? 0);
                        const lines: string[] = [];
                        if (totalUnmatched > 0) {
                          lines.push(
                            `Open Reconciliation to link the ${totalUnmatched} orphan${totalUnmatched === 1 ? "" : "s"} to FlipDesk SKUs.`,
                          );
                        }
                        if (r.errors && r.errors.length > 0) {
                          lines.push(
                            `Partial failure: ${r.errors[0]}` +
                              (r.errors.length > 1
                                ? ` (+${r.errors.length - 1} more)`
                                : ""),
                          );
                        }
                        const description = lines.length > 0
                          ? lines.join(" · ")
                          : undefined;
                        if (r.errors && r.errors.length > 0) {
                          toast.warning(
                            `Synced ${totalMatched} listing${totalMatched === 1 ? "" : "s"}${legacyLine}${salesLine}, with errors.`,
                            { description, duration: 14000 },
                          );
                        } else {
                          toast.success(
                            `Synced ${totalMatched} listing${totalMatched === 1 ? "" : "s"}${legacyLine}${salesLine}.`,
                            { description, duration: 8000 },
                          );
                        }
                      } catch {
                        /* surfaced by the hook */
                      }
                    }}
                    disabled={syncListings.isPending || syncSince != null}
                  >
                    {syncListings.isPending || syncSince != null ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-2 h-4 w-4" />
                    )}
                    {syncSince != null ? "Syncing…" : "Sync listings from eBay"}
                  </Button>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] text-muted-foreground">
                      {connection.last_synced_at
                        ? `Last synced ${formatAgo(connection.last_synced_at)}.`
                        : "Never synced yet."}
                    </p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => startOauth.mutate()}
                      disabled={startOauth.isPending}
                      className="text-xs text-muted-foreground"
                    >
                      Reconnect
                    </Button>
                  </div>
                </>
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
