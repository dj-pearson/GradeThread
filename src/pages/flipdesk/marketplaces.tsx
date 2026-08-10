import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  Plug,
  ArrowRight,
  FileSpreadsheet,
  Check,
  Loader2,
  RefreshCw,
  History,
  AlertTriangle,
  MapPin,
  CheckCircle2,
  AlertCircle,
  Circle,
  Puzzle,
  Clock,
  Megaphone,
} from "lucide-react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { EbayPromotionsCard } from "@/components/flipdesk/ebay-promotions-card";
import { EbayProgramsCard } from "@/components/flipdesk/ebay-programs-card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { SHIPPING_PROFILE_QUERY_KEY, fetchShippingProfile } from "@/lib/shipping-profile";
import {
  MARKETPLACE_EXTENSION_FLOW,
  MARKETPLACE_FLOW_LABEL,
  MARKETPLACE_LABELS,
  MARKETPLACE_TIER,
  MARKETPLACE_TIER_LABEL,
  marketplaceDisclosureFor,
} from "@/lib/constants";
import {
  useCreateEbayLocation,
  useDisconnectEbay,
  useEbayConnection,
  useEbayConnectionIssue,
  useEbayPolicies,
  useSetDefaultPolicies,
  useStartEbayOauth,
  useSyncEbayListings,
  useSyncEbayPolicies,
  useEbayPromotedOverview,
  useEbaySyncPromoted,
  type EbayConnection,
} from "@/hooks/use-ebay";
import {
  useDisconnectShopify,
  useShopifyConnection,
  useStartShopifyOauth,
  useSyncShopify,
} from "@/hooks/use-shopify";
import { safeHref } from "@/lib/safe-url";

// US-718: the non-API channels, grouped by their REAL tier (read from the
// MARKETPLACE_TIER single source of truth). eBay + Shopify are tier "api" and
// render as full live connector cards above; everything else lands here so the
// UI never advertises a channel above the integration that actually ships.
//   extension   — list from your own logged-in tab via the Lister extension.
//   api_pending — connector built, awaiting platform approval (Depop).
//   coming_soon — no integration yet.
const API_CHANNELS = Object.keys(MARKETPLACE_TIER).filter(
  (k) => MARKETPLACE_TIER[k as keyof typeof MARKETPLACE_TIER] === "api",
) as (keyof typeof MARKETPLACE_TIER)[];
const EXTENSION_CHANNELS = Object.keys(MARKETPLACE_TIER).filter(
  (k) => MARKETPLACE_TIER[k as keyof typeof MARKETPLACE_TIER] === "extension",
) as (keyof typeof MARKETPLACE_TIER)[];
const PENDING_CHANNELS = Object.keys(MARKETPLACE_TIER).filter(
  (k) => MARKETPLACE_TIER[k as keyof typeof MARKETPLACE_TIER] === "api_pending",
) as (keyof typeof MARKETPLACE_TIER)[];
// "other" is an internal bucket, not a real channel — never surface it.
const COMING_SOON_CHANNELS = Object.keys(MARKETPLACE_TIER).filter(
  (k) =>
    MARKETPLACE_TIER[k as keyof typeof MARKETPLACE_TIER] === "coming_soon" &&
    k !== "other",
) as (keyof typeof MARKETPLACE_TIER)[];

// User-facing copy for the Shopify OAuth callback result codes.
const SHOPIFY_CALLBACK_MESSAGES: Record<
  string,
  { type: "success" | "info" | "error"; message: string }
> = {
  connected: {
    type: "success",
    message: "Shopify store connected. FlipDesk can now publish and sync products.",
  },
  cancelled: { type: "info", message: "Shopify sign-in cancelled." },
  invalid_signature: {
    type: "error",
    message: "Shopify sign-in could not be verified. Please try again.",
  },
  invalid_state: {
    type: "error",
    message: "Shopify sign-in expired or was tampered with. Please try again.",
  },
  state_expired: {
    type: "error",
    message: "Shopify sign-in took too long and expired. Please try again.",
  },
  exchange_failed: {
    type: "error",
    message: "Could not complete Shopify sign-in. Please retry, and contact support if it persists.",
  },
};

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

// eBay attaches a fulfillment (shipping), payment, and return policy to every
// published offer. We auto-pick a default on first sync, but that guess can be
// wrong/invalid (publish then fails with eBay 25007 "invalid shipping policy").
const POLICY_KINDS = [
  { type: "fulfillment", label: "Shipping policy", key: "fulfillment_policy_id" },
  { type: "payment", label: "Payment policy", key: "payment_policy_id" },
  { type: "return", label: "Return policy", key: "return_policy_id" },
] as const;

// ── Ship-from location dialog ────────────────────────────────────────────
// eBay requires an ENABLED location on every published offer and offers no
// Seller Hub UI to create one, so we capture a ZIP once and create it via the
// Inventory API. Without this, publish fails with a "merchant location" blocker.
function EbayLocationDialog({
  open,
  onOpenChange,
  hasLocation,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasLocation: boolean;
}) {
  const createLocation = useCreateEbayLocation();
  const [zip, setZip] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");

  // US-2417: the address is no longer on the cached `profile` row — it is
  // ciphertext there — so the prefill reads it from the edge. `enabled: open`
  // keeps the request to the moment the dialog is actually shown.
  const shippingQuery = useQuery({
    queryKey: SHIPPING_PROFILE_QUERY_KEY,
    queryFn: fetchShippingProfile,
    enabled: open,
    staleTime: 5 * 60_000,
  });

  // US-1442: prefill from the saved ship-from profile so the seller doesn't
  // re-key their location here. Seeds only empty fields, and only while the
  // dialog is open, so it never clobbers an in-progress edit.
  useEffect(() => {
    if (!open) return;
    const addr = shippingQuery.data?.ship_from_address;
    if (!addr) return;
    if (addr.postal_code) setZip((z) => z || addr.postal_code!.trim());
    if (addr.city) setCity((c) => c || addr.city!.trim());
    if (addr.state) setState((s) => s || addr.state!.trim());
  }, [open, shippingQuery.data]);

  const save = async () => {
    if (!/^\d{5}(-\d{4})?$/.test(zip.trim())) {
      toast.error("Enter a valid US ZIP code (e.g. 90210).");
      return;
    }
    try {
      await createLocation.mutateAsync({
        postal_code: zip.trim(),
        country: "US",
        state: state.trim() || undefined,
        city: city.trim() || undefined,
      });
      onOpenChange(false);
    } catch {
      /* surfaced by the hook */
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5" />
            Ship-from location
          </DialogTitle>
          <DialogDescription>
            eBay requires a ship-from location on every listing, and there&apos;s
            no way to add one in Seller Hub. Set it here once — it&apos;s used for
            all your published listings.
            {hasLocation && " Saving a new ZIP replaces the current one."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="ship-zip">ZIP code</Label>
            <Input
              id="ship-zip"
              inputMode="numeric"
              placeholder="90210"
              value={zip}
              onChange={(e) => setZip(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ship-city">City (optional)</Label>
            <Input
              id="ship-city"
              placeholder="Beverly Hills"
              value={city}
              onChange={(e) => setCity(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="ship-state">State (optional)</Label>
            <Input
              id="ship-state"
              placeholder="CA"
              value={state}
              onChange={(e) => setState(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={createLocation.isPending}>
            {createLocation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <MapPin className="mr-2 h-4 w-4" />
            )}
            Save location
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Business policies dialog ─────────────────────────────────────────────
function EbayPoliciesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data, isLoading } = useEbayPolicies(true);
  const setDefaults = useSetDefaultPolicies();
  const resync = useSyncEbayPolicies();

  // Local selection seeded from the saved defaults; re-seed when data changes.
  const [selection, setSelection] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!data) return;
    setSelection({
      fulfillment_policy_id: data.defaults.fulfillment_policy_id ?? "",
      payment_policy_id: data.defaults.payment_policy_id ?? "",
      return_policy_id: data.defaults.return_policy_id ?? "",
    });
  }, [data]);

  const policies = data?.policies ?? [];
  const dirty =
    !!data &&
    POLICY_KINDS.some(
      (k) => (selection[k.key] ?? "") !== (data.defaults[k.key] ?? ""),
    );

  const save = async () => {
    const payload: Record<string, string> = {};
    for (const k of POLICY_KINDS) {
      if (selection[k.key]) payload[k.key] = selection[k.key]!;
    }
    try {
      await setDefaults.mutateAsync(payload);
      onOpenChange(false);
    } catch {
      /* surfaced by the hook */
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            Business policies
          </DialogTitle>
          <DialogDescription>
            eBay attaches a shipping, payment, and return policy to every listing.
            Pick the default for each — these are used when you publish. If a
            publish fails with &quot;invalid shipping policy,&quot; re-sync and
            re-pick the right one.
          </DialogDescription>
        </DialogHeader>

        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={() => resync.mutate()}
            disabled={resync.isPending}
          >
            {resync.isPending ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
            )}
            Re-sync from eBay
          </Button>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading your eBay policies…
          </div>
        ) : policies.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No business policies found on your eBay account yet. Create shipping,
            payment, and return policies in eBay Seller Hub, then click
            &quot;Re-sync from eBay.&quot;
          </p>
        ) : (
          <div className="space-y-3">
            {POLICY_KINDS.map((kind) => {
              const options = policies.filter((p) => p.policy_type === kind.type);
              return (
                <div key={kind.type} className="space-y-1">
                  <Label htmlFor={`policy-${kind.key}`} className="text-xs">
                    {kind.label}
                  </Label>
                  <select
                    id={`policy-${kind.key}`}
                    value={selection[kind.key] ?? ""}
                    onChange={(e) =>
                      setSelection((prev) => ({
                        ...prev,
                        [kind.key]: e.target.value,
                      }))
                    }
                    className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground [&>option]:bg-background [&>option]:text-foreground"
                  >
                    <option value="">
                      {options.length === 0
                        ? "None on your account"
                        : "Select a policy…"}
                    </option>
                    {options.map((p) => (
                      <option key={p.policy_id} value={p.policy_id}>
                        {p.policy_name}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        )}

        <DialogFooter>
          <Button onClick={save} disabled={!dirty || setDefaults.isPending}>
            {setDefaults.isPending && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Save defaults
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Setup checklist row ──────────────────────────────────────────────────
type StepState = "done" | "todo" | "blocked" | "loading";

function StepRow({
  state,
  label,
  status,
  action,
}: {
  state: StepState;
  label: string;
  status: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <div className="flex min-w-0 items-center gap-3">
        {state === "done" ? (
          <CheckCircle2 className="h-5 w-5 flex-shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : state === "blocked" ? (
          <Circle className="h-5 w-5 flex-shrink-0 text-muted-foreground/40" />
        ) : state === "loading" ? (
          <Loader2 className="h-5 w-5 flex-shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <AlertCircle className="h-5 w-5 flex-shrink-0 text-amber-500" />
        )}
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          <p className="truncate text-xs text-muted-foreground">{status}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

// ── eBay setup + sync card ───────────────────────────────────────────────
// One cohesive surface: a readiness checklist (connection → location →
// policies) that collapses to a "Ready to publish" banner when complete, plus
// the day-to-day sync actions once connected.
function EbaySetup({
  connection,
  connLoading,
  syncing,
  onSync,
  onConnect,
  oauthPending,
}: {
  connection: EbayConnection | null | undefined;
  connLoading: boolean;
  syncing: boolean;
  onSync: (full: boolean) => void;
  onConnect: () => void;
  oauthPending: boolean;
}) {
  const connected = !!connection;
  const disconnect = useDisconnectEbay();
  const { data: policyData, isLoading: polLoading } = useEbayPolicies(connected);
  const defaults = policyData?.defaults;
  const hasLocation = !!defaults?.merchant_location_key;
  const hasPolicies = !!(
    defaults?.fulfillment_policy_id &&
    defaults?.payment_policy_id &&
    defaults?.return_policy_id
  );

  const [dialog, setDialog] = useState<null | "location" | "policies">(null);
  const [manageOpen, setManageOpen] = useState(false);

  const doneCount =
    (connected ? 1 : 0) +
    (connected && hasLocation ? 1 : 0) +
    (connected && hasPolicies ? 1 : 0);
  const allReady = connected && hasLocation && hasPolicies;
  const pct = Math.round((doneCount / 3) * 100);
  const polReady = connected && !polLoading;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <Plug className="h-5 w-5" />
            {allReady ? "eBay" : "Get ready to sell on eBay"}
          </CardTitle>
          {connected ? (
            <Badge className="bg-emerald-600 hover:bg-emerald-600">
              <Check className="mr-1 h-3 w-3" />
              Connected
              {connection?.account_handle ? ` · ${connection.account_handle}` : ""}
            </Badge>
          ) : (
            <Badge variant="secondary">Setup required</Badge>
          )}
        </div>
        {!allReady && (
          <CardDescription>
            Three quick steps before FlipDesk can publish listings to eBay.
          </CardDescription>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {allReady && !manageOpen ? (
          <div className="flex items-center justify-between rounded-lg border border-emerald-600/30 bg-emerald-600/5 px-3 py-2.5">
            <span className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="h-4 w-4" />
              Ready to publish on eBay
            </span>
            <Button variant="ghost" size="sm" onClick={() => setManageOpen(true)}>
              Manage
            </Button>
          </div>
        ) : (
          <>
            {!allReady && (
              <div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-brand-navy transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {doneCount} of 3 complete
                </p>
              </div>
            )}

            <div className="rounded-lg border px-3 [&>*+*]:border-t">
              {/* 1 — account */}
              <StepRow
                state={connected ? "done" : connLoading ? "loading" : "todo"}
                label="Connect your eBay account"
                status={
                  connLoading
                    ? "Checking…"
                    : connected
                      ? `Connected${connection?.account_handle ? ` as ${connection.account_handle}` : ""}`
                      : "A direct OAuth connection syncs listings, pushes drafts, and streams payouts."
                }
                action={
                  connected ? (
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={onConnect}
                        disabled={oauthPending}
                      >
                        Reconnect
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => disconnect.mutate()}
                        disabled={disconnect.isPending}
                      >
                        {disconnect.isPending && (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        )}
                        Disconnect
                      </Button>
                    </div>
                  ) : (
                    <Button size="sm" onClick={onConnect} disabled={oauthPending}>
                      {oauthPending && (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      )}
                      Connect eBay
                    </Button>
                  )
                }
              />

              {/* 2 — ship-from location */}
              <StepRow
                state={
                  !connected
                    ? "blocked"
                    : polLoading
                      ? "loading"
                      : hasLocation
                        ? "done"
                        : "todo"
                }
                label="Ship-from location"
                status={
                  !connected
                    ? "Connect your account first"
                    : polLoading
                      ? "Checking…"
                      : hasLocation
                        ? "Set — used on every listing"
                        : "eBay needs a ship-from location to publish"
                }
                action={
                  polReady ? (
                    <Button
                      size="sm"
                      variant={hasLocation ? "ghost" : "default"}
                      onClick={() => setDialog("location")}
                    >
                      {hasLocation ? "Edit" : "Set up"}
                    </Button>
                  ) : undefined
                }
              />

              {/* 3 — business policies */}
              <StepRow
                state={
                  !connected
                    ? "blocked"
                    : polLoading
                      ? "loading"
                      : hasPolicies
                        ? "done"
                        : "todo"
                }
                label="Business policies"
                status={
                  !connected
                    ? "Connect your account first"
                    : polLoading
                      ? "Checking…"
                      : hasPolicies
                        ? "Shipping, payment & return set"
                        : "Pick a shipping, payment & return default"
                }
                action={
                  polReady ? (
                    <Button
                      size="sm"
                      variant={hasPolicies ? "ghost" : "default"}
                      onClick={() => setDialog("policies")}
                    >
                      {hasPolicies ? "Edit" : "Set up"}
                    </Button>
                  ) : undefined
                }
              />
            </div>

            {allReady && manageOpen && (
              <div className="flex justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setManageOpen(false)}
                >
                  Done
                </Button>
              </div>
            )}
          </>
        )}

        {/* Day-to-day sync — only once connected */}
        {connected && (
          <div className="space-y-2 border-t pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => onSync(false)} disabled={syncing} size="sm">
                {syncing ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                {syncing ? "Syncing…" : "Sync listings from eBay"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onSync(true)}
                disabled={syncing}
              >
                <History className="mr-2 h-4 w-4" />
                Import full sales history
              </Button>
              <span className="ml-auto text-[11px] text-muted-foreground">
                {connection?.last_synced_at
                  ? `Last synced ${formatAgo(connection.last_synced_at)}.`
                  : "Never synced yet."}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Full import is a one-time backfill: it pulls sold orders from the
              last ~24 months, including items not yet in FlipDesk (those land in
              Reconciliation).
            </p>
          </div>
        )}
      </CardContent>

      <EbayLocationDialog
        open={dialog === "location"}
        onOpenChange={(o) => setDialog(o ? "location" : null)}
        hasLocation={hasLocation}
      />
      <EbayPoliciesDialog
        open={dialog === "policies"}
        onOpenChange={(o) => setDialog(o ? "policies" : null)}
      />
    </Card>
  );
}

// ── Shopify setup + sync card (US-599) ───────────────────────────────────
// Shopify uses a single store-domain → OAuth → done flow (no policies/location
// like eBay). Once connected, the same card runs the day-to-day sync.
function ShopifySetup() {
  const { data: connection, isLoading } = useShopifyConnection();
  const startOauth = useStartShopifyOauth();
  const disconnect = useDisconnectShopify();
  const sync = useSyncShopify();
  const [shop, setShop] = useState("");
  const connected = !!connection;

  const connect = () => {
    const trimmed = shop.trim();
    if (!trimmed) {
      toast.error("Enter your Shopify store domain (e.g. my-store.myshopify.com).");
      return;
    }
    startOauth.mutate({ shop: trimmed });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <Plug className="h-5 w-5" />
            Shopify
          </CardTitle>
          {connected ? (
            <Badge className="bg-emerald-600 hover:bg-emerald-600">
              <Check className="mr-1 h-3 w-3" />
              Connected
              {connection?.account_handle ? ` · ${connection.account_handle}` : ""}
            </Badge>
          ) : (
            <Badge variant="secondary">Not connected</Badge>
          )}
        </div>
        <CardDescription>
          Publish FlipDesk drafts as Shopify products and sync orders back for
          reconciliation — a real list / sync / delist connection.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!connected ? (
          <div className="space-y-2">
            <Label htmlFor="shopify-domain" className="text-xs">
              Store domain
            </Label>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                id="shopify-domain"
                placeholder="my-store.myshopify.com"
                value={shop}
                onChange={(e) => setShop(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") connect();
                }}
                className="max-w-xs"
                disabled={isLoading || startOauth.isPending}
              />
              <Button onClick={connect} disabled={startOauth.isPending} size="sm">
                {startOauth.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                Connect Shopify
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <Button onClick={() => sync.mutate()} disabled={sync.isPending} size="sm">
              {sync.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              {sync.isPending ? "Syncing…" : "Sync from Shopify"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
            >
              {disconnect.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Disconnect
            </Button>
            <span className="ml-auto text-[11px] text-muted-foreground">
              {connection?.last_synced_at
                ? `Last synced ${formatAgo(connection.last_synced_at)}.`
                : "Never synced yet."}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Promoted listings overview (US-1044) ─────────────────────────────────
// A roll-up of the workspace's eBay Promoted Listings: live ad status, bid %,
// and the Cost-Per-Sale ad fee (charged only on an attributed sale). Per-listing
// opt in/out + rate changes live on each item page; this is the read + refresh
// surface. eBay's click/impression breakdown comes from its async ad report, so
// it's intentionally not faked here.
function formatUsd(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function PromoStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function PromotedListingsSection() {
  const qc = useQueryClient();
  const { data, isLoading } = useEbayPromotedOverview(true);
  const sync = useEbaySyncPromoted();

  const refresh = async () => {
    try {
      const r = await sync.mutateAsync();
      await qc.invalidateQueries({ queryKey: ["ebay_promoted_overview"] });
      toast.success(
        `Refreshed ${r.updated} of ${r.scanned} promoted listing${r.scanned === 1 ? "" : "s"}.`,
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't refresh promoted listings.");
    }
  };

  const listings = data?.listings ?? [];
  const summary = data?.summary;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <Megaphone className="h-5 w-5" />
            Promoted listings
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={sync.isPending}
          >
            {sync.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Refresh from eBay
          </Button>
        </div>
        <CardDescription>
          Promoted Listings is a Cost-Per-Sale ad — eBay charges the ad rate only
          when the item sells through the ad, never up front. Set each listing&apos;s
          rate or opt out from its item page.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading promoted listings…
          </div>
        ) : listings.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No promoted listings yet. An ad is attached automatically when you
            publish (unless you opt out), or promote a live listing from its item
            page.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <PromoStat label="Promoted" value={String(summary?.total ?? listings.length)} />
              <PromoStat label="Active" value={String(summary?.active ?? 0)} />
              <PromoStat
                label="Attributed sales"
                value={String(summary?.attributed_sales ?? 0)}
              />
              <PromoStat
                label="Ad fees"
                value={formatUsd((summary?.ad_fees_cents ?? 0) / 100)}
              />
            </div>

            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Listing</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Ad rate</TableHead>
                    <TableHead className="text-right">Ad fees</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {listings.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="max-w-[18rem]">
                        {safeHref(l.listing_url) ? (
                          <a
                            href={safeHref(l.listing_url) ?? undefined}
                            target="_blank"
                            rel="noreferrer"
                            className="block truncate font-medium text-brand-navy hover:underline dark:text-foreground"
                            title={l.listing_title ?? undefined}
                          >
                            {l.listing_title ?? "Untitled listing"}
                          </a>
                        ) : (
                          <span className="block truncate font-medium" title={l.listing_title ?? undefined}>
                            {l.listing_title ?? "Untitled listing"}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="font-normal capitalize">
                          {(l.promo_status ?? "unknown").toLowerCase()}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {l.promo_rate_pct != null ? `${l.promo_rate_pct}%` : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatUsd((l.promo_ad_fees_cents ?? 0) / 100)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <p className="text-[11px] text-muted-foreground">
              Ad fees accrue only on sales attributed to the ad — “Attributed
              sales” counts listings that have been charged a Cost-Per-Sale fee.
              eBay&apos;s full click/impression breakdown lives in its Promoted
              Listings report; FlipDesk surfaces the live status, bid %, and
              attributed ad spend it syncs back.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// US-2475: the per-channel risk block.
//
// One component for every marketplace, with the CONTENT resolved from
// MARKETPLACE_MECHANISM (via marketplaceDisclosureFor) rather than written per
// platform here. That is deliberate: a hand-written block per channel is a block
// that gets forgotten for channel number six, which is how a seller discovers
// the terms-of-service position after their account is limited instead of
// before. Adding a platform without disclosure copy fails the unit test rather
// than shipping quietly.
function ChannelRisk({ platform }: { platform: keyof typeof MARKETPLACE_TIER }) {
  const d = marketplaceDisclosureFor(platform);
  const tier = MARKETPLACE_TIER[platform];
  // US-2477..US-2480: the tier badge says HOW a channel is reached. It has never
  // said whether the flow is switched on, and for three channels the answer was
  // "no" while the badge read "Connect via browser extension". Say both.
  const flow =
    MARKETPLACE_EXTENSION_FLOW[
      platform as keyof typeof MARKETPLACE_EXTENSION_FLOW
    ];
  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{MARKETPLACE_LABELS[platform]}</span>
        <span className="flex flex-wrap items-center gap-1.5">
          {flow && (
            <Badge
              variant={flow === "live" ? "secondary" : "outline"}
              className="text-[10px]"
            >
              {MARKETPLACE_FLOW_LABEL[flow]}
            </Badge>
          )}
          <Badge variant="outline" className="text-[10px]">
            {MARKETPLACE_TIER_LABEL[tier]}
          </Badge>
        </span>
      </div>
      <p className="mt-1 text-xs font-medium text-foreground/80">{d.title}</p>
      <ul className="mt-2 space-y-1.5">
        {d.facts.map((fact) => (
          <li
            key={fact}
            className="flex gap-2 text-xs leading-relaxed text-muted-foreground"
          >
            <Circle
              aria-hidden="true"
              className="mt-1.5 h-1 w-1 flex-shrink-0 fill-current"
            />
            <span>{fact}</span>
          </li>
        ))}
      </ul>
      {d.href && (
        <Link
          to={d.href}
          className="mt-2 inline-block text-xs font-medium text-brand-navy underline underline-offset-2"
        >
          {d.hrefLabel ?? "Read more"}
        </Link>
      )}
    </div>
  );
}

export function FlipdeskMarketplacesPage() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();

  // When a background sync is running we poll last_synced_at every 5s.
  // US-1634: hold the SERVER's last_synced_at from BEFORE we fired the sync as a
  // baseline, and detect completion when it CHANGES — comparing server value to
  // server value. The old code compared the client's clock at fire time to the
  // server timestamp, so a client clock running ahead of the server never saw
  // completion → the "syncing…" toast hung forever.
  const [syncBaseline, setSyncBaseline] = useState<{ before: string | null } | null>(null);
  const syncToastId = useRef<string | number | null>(null);

  const clearSyncToast = () => {
    if (syncToastId.current != null) {
      toast.dismiss(syncToastId.current);
      syncToastId.current = null;
    }
  };

  const pollingInterval = syncBaseline != null ? 5_000 : undefined;
  const { data: connection, isLoading: connLoading } = useEbayConnection(pollingInterval);
  const { data: connIssue } = useEbayConnectionIssue();
  const startOauth = useStartEbayOauth();
  const syncListings = useSyncEbayListings();

  // Detect completion: last_synced_at changed from the pre-sync baseline.
  useEffect(() => {
    if (!syncBaseline) return;
    const current = connection?.last_synced_at ?? null;
    if (current != null && current !== syncBaseline.before) {
      setSyncBaseline(null);
      clearSyncToast();
      qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success("eBay sync complete. Listings updated.");
    }
  }, [connection?.last_synced_at, syncBaseline, qc]);

  // US-1634: failure path — if the sync never reports back within a generous
  // window (a stuck/failed background run), stop polling and dismiss the toast
  // with a "check back" message instead of spinning forever.
  useEffect(() => {
    if (!syncBaseline) return;
    const t = setTimeout(() => {
      setSyncBaseline(null);
      clearSyncToast();
      toast.info("eBay sync is taking longer than expected — check back shortly.");
    }, 5 * 60_000);
    return () => clearTimeout(t);
  }, [syncBaseline]);

  // Shared handler for both the incremental sync and the full backfill.
  // `full` reaches back ~24 months for sales that predate the connection.
  const runSync = async (full: boolean) => {
    try {
      // US-1634: snapshot the SERVER's current last_synced_at as the baseline
      // (not the client clock) so completion is a server-to-server comparison.
      const before = connection?.last_synced_at ?? null;
      const r = await syncListings.mutateAsync({ full });

      if (r.started) {
        // 202 — sync is running in the background.
        // Start polling; show a persistent toast until done.
        setSyncBaseline({ before });
        syncToastId.current = toast.loading(
          full
            ? "Importing full eBay sales history…"
            : "eBay sync running in background…",
          {
            description: full
              ? "Reaching back ~24 months. Sales will update automatically when done."
              : "Listings and sales will update automatically when done.",
            duration: Infinity,
          },
        );
        return;
      }

      // 200 — sync completed synchronously (shouldn't happen after the 202
      // change, but handle gracefully).
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
            (r.errors.length > 1 ? ` (+${r.errors.length - 1} more)` : ""),
        );
      }
      const description = lines.length > 0 ? lines.join(" · ") : undefined;
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
  };

  // Surface the OAuth callback result once and strip it from the URL so a
  // reload doesn't re-toast.
  useEffect(() => {
    const ebayCode = params.get("ebay");
    const shopifyCode = params.get("shopify");
    if (!ebayCode && !shopifyCode) return;
    const show = (entry: { type: "success" | "info" | "error"; message: string }) => {
      if (entry.type === "success") toast.success(entry.message);
      else if (entry.type === "info") toast.info(entry.message);
      else toast.error(entry.message);
    };
    if (ebayCode && CALLBACK_MESSAGES[ebayCode]) show(CALLBACK_MESSAGES[ebayCode]);
    if (shopifyCode && SHOPIFY_CALLBACK_MESSAGES[shopifyCode]) {
      show(SHOPIFY_CALLBACK_MESSAGES[shopifyCode]);
    }
    const next = new URLSearchParams(params);
    next.delete("ebay");
    next.delete("shopify");
    setParams(next, { replace: true });
  }, [params, setParams]);

  const syncing = syncListings.isPending || syncBaseline != null;

  // Per-user FlipDesk behavior settings (migration 00134). Absent row =
  // defaults (auto-end ON), so the toggle reads that until the user changes it.
  const user = useAuthStore((s) => s.user);
  const { data: fdSettings } = useQuery({
    queryKey: ["flipdesk_settings", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("flipdesk_settings")
        .select("auto_end_cross_listings")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return data as { auto_end_cross_listings: boolean } | null;
    },
  });
  // `undefined` while loading (disables the switch); resolved → boolean default.
  const settingsLoaded = fdSettings !== undefined;
  const autoEndSetting = !settingsLoaded
    ? undefined
    : fdSettings?.auto_end_cross_listings ?? true;
  const [autoEndSaving, setAutoEndSaving] = useState(false);

  async function toggleAutoEnd(next: boolean) {
    if (!user) return;
    setAutoEndSaving(true);
    try {
      const { error } = await supabase
        .from("flipdesk_settings")
        .upsert(
          { user_id: user.id, auto_end_cross_listings: next } as never,
          { onConflict: "user_id" },
        );
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["flipdesk_settings", user.id] });
      toast.success(
        next
          ? "Cross-listed siblings will end automatically when one sells."
          : "Auto-end disabled — end other listings yourself after a sale.",
      );
    } catch (err) {
      toast.error(
        `Couldn't save the setting: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setAutoEndSaving(false);
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        icon={Plug}
        title="Marketplaces"
        subtitle="How FlipDesk talks to the platforms you sell on."
      />

      {/* US-463: a connection deactivated by a permanent token-refresh failure
          (revoked/expired grant) needs explicit re-auth. Show a clear banner
          with a reconnect action rather than silently reverting to the
          "Connect eBay" CTA. */}
      {connIssue && !connIssue.is_active && connIssue.refresh_error && (
        <div className="flex flex-col gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" />
            <span className="text-foreground">{connIssue.refresh_error}</span>
          </div>
          <Button
            size="sm"
            onClick={() => startOauth.mutate()}
            disabled={startOauth.isPending}
            className="shrink-0"
          >
            {startOauth.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Reconnect eBay
          </Button>
        </div>
      )}

      {/* Active — eBay setup + sync */}
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Active
        </h2>
        <div className="space-y-4">
          <EbaySetup
            connection={connection}
            connLoading={connLoading}
            syncing={syncing}
            onSync={runSync}
            onConnect={() => startOauth.mutate()}
            oauthPending={startOauth.isPending}
          />
          <ShopifySetup />
          {connection && <PromotedListingsSection />}
          {/* US-1448: surface the seller's eBay Promotions Manager offers. */}
          {connection && <EbayPromotionsCard />}
          {/* US-2157: eBay account-level program opt-in (out-of-stock control,
              business policy management). */}
          {connection && <EbayProgramsCard />}
        </div>
      </section>

      {/* More ways to sync — Google Sheets + CSV fallback */}
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          More ways to sync
        </h2>
        <div className="space-y-2">
          <Link
            to="/dashboard/flipdesk/marketplaces/google"
            className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm transition-colors hover:bg-muted/50"
          >
            <span className="flex items-center gap-2">
              <FileSpreadsheet className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              Google Sheets — connect a Google account and FlipDesk keeps a live
              sync spreadsheet on your Drive.
            </span>
            <ArrowRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          </Link>
          <Link
            to="/dashboard/flipdesk/money?view=reconcile&tab=ebay"
            className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm transition-colors hover:bg-muted/50"
          >
            <span className="flex items-center gap-2">
              <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
              Import via CSV — upload your Active Listings report, no developer
              account needed.
            </span>
            <ArrowRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          </Link>
        </div>
      </section>

      {/* Cross-listing behavior (US-149) */}
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Cross-listing
        </h2>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
          <div className="space-y-0.5">
            <Label htmlFor="auto-end-cross" className="text-sm font-medium">
              Auto-end cross-listings on sale
            </Label>
            <p className="text-xs text-muted-foreground">
              When an item pushed to multiple marketplaces sells on one of
              them, automatically end its listings on the others.
            </p>
          </div>
          <Switch
            id="auto-end-cross"
            checked={autoEndSetting ?? true}
            disabled={autoEndSaving || autoEndSetting === undefined}
            onCheckedChange={(v) => void toggleAutoEnd(v)}
          />
        </div>
      </section>

      {/* Grade authority signal — text only (eBay-policy pivot) */}
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Grade promotion
        </h2>
        <div className="rounded-lg border p-3 text-sm">
          <p className="font-medium">Graded listings show the grade as text</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            When you publish a graded item, GradeThread automatically adds the
            grade to the description and a “Condition Grade” item specific, with
            a link to the certificate page buyers can verify. We never add
            badges, watermarks, or QR codes to your photos — overlays on listing
            images can get marketplace accounts suspended.
          </p>
        </div>
      </section>

      {/* US-718: extension tier — Poshmark/Mercari/Grailed have no public write
          API, so they're listed from the seller's own logged-in tab via the
          GradeThread Lister browser extension (US-716). Presented honestly as a
          real, available capability — not "coming soon". */}
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Connect via browser extension
        </h2>
        <div className="mb-3 flex items-start gap-3 rounded-lg border p-3">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-brand-navy/10 text-brand-navy">
            <Puzzle className="h-4 w-4" />
          </div>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">GradeThread Lister</span>
              <Badge variant="secondary" className="text-[10px]">
                Your browser
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              These platforms have no public listing API. Install the
              GradeThread Lister browser extension and cross-list a finished
              draft straight from your own logged-in tab — title, photos, price
              and the grade badge are filled in for you. Each channel below
              states what that means for your account.
            </p>
          </div>
        </div>
        {/* US-2475: one risk block per channel, driven by MARKETPLACE_MECHANISM. */}
        <div className="space-y-2">
          {EXTENSION_CHANNELS.map((m) => (
            <ChannelRisk key={m} platform={m} />
          ))}
        </div>
      </section>

      {/* US-2475: the same disclosure for the API-tier channels — a sanctioned
          developer connection is a different risk position from browser
          automation, and a seller comparing the two should be able to read both
          in the same words. */}
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          How your API connections work
        </h2>
        <div className="space-y-2">
          {API_CHANNELS.map((m) => (
            <ChannelRisk key={m} platform={m} />
          ))}
        </div>
      </section>

      {/* Coming soon — api_pending (connector built, awaiting approval) +
          channels with no integration yet. Muted rows, never a fake connect
          flow for an unbuilt API path. */}
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Coming soon
        </h2>
        <div className="space-y-2">
          {PENDING_CHANNELS.map((m) => (
            <div key={m} className="rounded-lg border border-dashed p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-2 font-medium">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  {MARKETPLACE_LABELS[m]}
                </span>
                <Badge variant="outline" className="text-[10px]">
                  API ready · pending {MARKETPLACE_LABELS[m]} approval
                </Badge>
              </div>
              {/* US-2475: the connector is built, so the disclosure that will
                  apply the moment it is switched on is stated now, not later. */}
              <ul className="mt-2 space-y-1.5">
                {marketplaceDisclosureFor(m).facts.map((fact) => (
                  <li
                    key={fact}
                    className="flex gap-2 text-xs leading-relaxed text-muted-foreground"
                  >
                    <Circle
                      aria-hidden="true"
                      className="mt-1.5 h-1 w-1 flex-shrink-0 fill-current"
                    />
                    <span>{fact}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {COMING_SOON_CHANNELS.length > 0 && (
            <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
              {COMING_SOON_CHANNELS.map((m) => MARKETPLACE_LABELS[m]).join(" · ")}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
