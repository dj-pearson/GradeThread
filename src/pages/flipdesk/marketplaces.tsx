import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { finishedRunNote, marketplaceLabel } from "@/lib/finished-queue-run";
import {
  drainNudgeSentence,
  isListerAvailable,
  requestDrainNow,
} from "@/lib/lister-extension";
import { LinkDuplicatesCard } from "@/components/flipdesk/link-duplicates-card";
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
import { toastError } from "@/lib/toast-error";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MarketplaceConnectionSummary } from "@/components/flipdesk/marketplace-connection-summary";
import { EbayPromotionsCard } from "@/components/flipdesk/ebay-promotions-card";
import { EbayKeywordsCard } from "@/components/flipdesk/ebay-keywords-card";
import { EbayCampaignCard } from "@/components/flipdesk/ebay-campaign-card";
import { PromotionPerformanceCard } from "@/components/flipdesk/promotion-performance-card";
import { FollowerCampaignCard } from "@/components/flipdesk/follower-campaign-card";
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
  MARKETPLACE_EXTENSION_FLOWS,
  MARKETPLACE_FLOW_CAPABILITY_LABEL,
  MARKETPLACE_FLOW_LABEL,
  MARKETPLACE_LABELS,
  MARKETPLACE_TIER,
  MARKETPLACE_TIER_LABEL,
} from "@/lib/constants";
import { marketplaceDisclosureFor } from "@/lib/marketplace-disclosure";
import {
  useCreateEbayLocation,
  useDisconnectEbay,
  useEbayConnection,
  useEbayConnectionIssue,
  isReauthNeeded,
  reauthMessage,
  useCreateEbayPolicies,
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
import {
  groupQueue,
  QUEUED_NOTICE,
  useCancelExtensionWork,
  useExtensionQueue,
  useRequeueExtensionWork,
  canRequeue,
  type ExtensionQueueItem,
} from "@/hooks/use-extension-queue";
import { CrossPostSetup } from "@/components/flipdesk/cross-post-setup";
import { CrossPostChannelPicker } from "@/components/flipdesk/cross-post-channel-picker";
import { ListerLocalePicker } from "@/components/flipdesk/lister-locale-picker";
import { ListingBadgeToggle } from "@/components/flipdesk/listing-badge-toggle";
import {
  syncStateCopy,
  useDismissSyncReview,
  useSyncReviews,
  useSyncStatus,
  type SyncReview,
  POLL_INTERVAL_CHOICES,
  groupCopy,
  reviewGroupOf,
  REVIEW_GROUP_ORDER,
  stoppedChannelCopy,
  useClaimSyncReview,
  useClaimCandidates,
  type ClaimCandidate,
  type ReviewGroup,
  useSetPollInterval,
  useStopPoll,
  usePollState,
} from "@/hooks/use-sold-sync";
import { HelpLink } from "@/components/help/help-link";
import { useWorkspace } from "@/hooks/use-workspace";
import { MARKETPLACE_ADMIN_ONLY, SETTINGS_OWNER_ONLY } from "@/lib/workspace-permissions";
import { useOwnsActiveWorkspace } from "@/hooks/use-tenant-key";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";

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

// The tab the page opens on. The Tabs are controlled so the Ads and Settings
// prompts can send a seller back to Connections.
const DEFAULT_TAB = "connections";
// MP-14: the tab lives in the URL (?tab=), so a reload, the back button and a
// link from elsewhere all land on the tab they name.
const TABS = ["connections", "ads", "settings", "how"] as const;
// Anchors that live on the Connections tab. A link to one of them opens that
// tab first, or the element does not exist to scroll to.
const CONNECTIONS_ANCHORS = new Set(["extension-queue", "ebay-setup", "shopify-setup"]);

// User-facing copy for the Shopify OAuth callback result codes.
const SHOPIFY_CALLBACK_MESSAGES: Record<
  string,
  { type: "success" | "info" | "error"; message: string }
> = {
  connected: {
    type: "success",
    message: "Shopify store connected. FlipDesk can now publish and sync products.",
  },
  cancelled: { type: "info", message: "Shopify sign-in canceled." },
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
    message: "eBay sign-in canceled.",
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
  // MP-12: standard OAuth codes the edge passes through (iOS words them too).
  invalid_scope: {
    type: "error",
    message: "eBay turned down the permissions FlipDesk asked for. Please try again.",
  },
  server_error: {
    type: "error",
    message: "eBay is having trouble right now. Try again in a few minutes.",
  },
  temporarily_unavailable: {
    type: "error",
    message: "eBay is having trouble right now. Try again in a few minutes.",
  },
};

// MP-12: any code neither map knows (provider_error, or a code from an older
// edge) still says something. Before, an unknown code returned the seller to
// the page with no message at all.
const CALLBACK_FALLBACK = {
  type: "error" as const,
  message: "eBay sign-in didn't finish. Try again, and contact support if it keeps happening.",
};
const SHOPIFY_CALLBACK_FALLBACK = {
  type: "error" as const,
  message: "Shopify sign-in didn't finish. Try again, and contact support if it keeps happening.",
};

// MP-12: the confirm in front of Disconnect. It names the account and says
// what stops, because a one-click ghost button next to Reconnect revoked the
// grant with no warning.
function DisconnectConfirm({
  channel,
  account,
  consequence,
  pending,
  onConfirm,
}: {
  channel: string;
  account: string | null | undefined;
  consequence: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive hover:text-destructive"
        onClick={() => setOpen(true)}
        disabled={pending}
      >
        {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        Disconnect
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Disconnect {channel}
              {account ? ` (${account})` : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>{consequence}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it connected</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

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
  // MP-13: the saved ship-from profile is the SIGNED-IN user's, and this saves
  // to the workspace owner's eBay account. Inside someone else's workspace that
  // prefill sent a member's home address to the owner's account.
  const ownWorkspace = useOwnsActiveWorkspace();
  const [zip, setZip] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");

  // US-2417: the address is no longer on the cached `profile` row — it is
  // ciphertext there — so the prefill reads it from the edge. `enabled: open`
  // keeps the request to the moment the dialog is actually shown.
  const shippingQuery = useQuery({
    queryKey: SHIPPING_PROFILE_QUERY_KEY,
    queryFn: fetchShippingProfile,
    enabled: open && ownWorkspace,
    staleTime: 5 * 60_000,
  });

  // US-1442: prefill from the saved ship-from profile so the seller doesn't
  // re-key their location here. Seeds only empty fields, and only while the
  // dialog is open, so it never clobbers an in-progress edit.
  useEffect(() => {
    if (!open || !ownWorkspace) return;
    const addr = shippingQuery.data?.ship_from_address;
    if (!addr) return;
    if (addr.postal_code) setZip((z) => z || addr.postal_code!.trim());
    if (addr.city) setCity((c) => c || addr.city!.trim());
    if (addr.state) setState((s) => s || addr.state!.trim());
  }, [open, ownWorkspace, shippingQuery.data]);

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
            {!ownWorkspace && " Enter the ZIP this workspace ships from."}
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
  // MP-07: only while open. The dialog is always mounted, and reading here on
  // every page load called GET /policies (and eBay) even when disconnected.
  const { data, isLoading, isError, refetch } = useEbayPolicies(open);
  const setDefaults = useSetDefaultPolicies();
  const resync = useSyncEbayPolicies();
  // US-3265: the way out of the dead end below. Four answers, and FlipDesk
  // creates the policies on the seller's eBay account.
  const createPolicies = useCreateEbayPolicies();
  const [handlingDays, setHandlingDays] = useState("1");
  const [shippingCost, setShippingCost] = useState("0");
  const [acceptsReturns, setAcceptsReturns] = useState(true);
  const [returnDays, setReturnDays] = useState<"30" | "60">("30");
  const [returnPaidBy, setReturnPaidBy] = useState<"BUYER" | "SELLER">("BUYER");
  // MP-13: these become live buyer commitments on eBay. A blank handling field
  // used to become 0 days and a typo in postage became free shipping.
  const handlingNum = Number(handlingDays);
  const handlingValid =
    handlingDays.trim() !== "" && Number.isInteger(handlingNum) && handlingNum >= 1 &&
    handlingNum <= 30;
  const postageNum = Number(shippingCost);
  const postageValid =
    shippingCost.trim() !== "" && Number.isFinite(postageNum) && postageNum >= 0;
  const policySummary = `Ships within ${handlingValid ? handlingNum : "?"} day${
    handlingNum === 1 ? "" : "s"
  }, buyer pays ${
    postageValid ? (postageNum === 0 ? "nothing (free postage)" : `$${postageNum.toFixed(2)}`) : "?"
  } for postage, ${
    acceptsReturns
      ? `${returnDays}-day returns, ${returnPaidBy === "BUYER" ? "buyer" : "you"} pay${
        returnPaidBy === "BUYER" ? "s" : ""
      } return postage.`
      : "no returns."
  }`;

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
  // US-3265 (AC6): the offer is gated on a MISSING KIND, not on an empty list.
  // eBay needs all three, and the route already creates only the ones the
  // account lacks -- so an account with a payment policy and no shipping policy
  // is the same dead end as an account with none, just one step further in.
  const missingKinds = POLICY_KINDS.filter(
    (k) => !policies.some((p) => p.policy_type === k.type),
  );
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

        {isError ? (
          // MP-07: a 502 used to fall through to "no business policies yet,
          // Create these for me", which offers to create live policies on an
          // account that may already have them.
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
          >
            <span>
              Couldn&apos;t load your eBay policies. This is a loading problem,
              not missing policies.
            </span>
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              Check again
            </Button>
          </div>
        ) : isLoading ? (
          <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading your eBay policies…
          </div>
        ) : (
          <div className="space-y-5">
            {missingKinds.length > 0 && (
              /* US-3265: this used to say "set them up in eBay Seller Hub, then
                 press Re-sync" -- a hand-off in the middle of connecting, to the
                 account least equipped to take it, with every publish refused
                 until it came back. FlipDesk holds the seller's eBay token and
                 already creates the merchant location nobody else creates; these
                 four answers are the rest of it. */
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  {policies.length === 0
                    ? "This eBay account has no business policies yet. Answer these and FlipDesk will create the three that eBay requires. You can change any of it on eBay later."
                    : `This eBay account is missing its ${
                      missingKinds.map((k) => k.label.toLowerCase()).join(" and ")
                    }. Answer these and FlipDesk will create what is missing. The policies you already have are left exactly as they are.`}
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="policy-handling" className="text-xs">
                      Days to post after a sale
                    </Label>
                    <Input
                      id="policy-handling"
                      type="number"
                      min={1}
                      max={30}
                      value={handlingDays}
                      aria-invalid={!handlingValid}
                      aria-describedby={handlingValid ? undefined : "policy-handling-error"}
                      onChange={(e) => setHandlingDays(e.target.value)}
                    />
                    {!handlingValid && (
                      <p id="policy-handling-error" className="text-xs text-destructive">
                        Enter a whole number of days from 1 to 30.
                      </p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="policy-shipping" className="text-xs">
                      What the buyer pays for postage (0 for free)
                    </Label>
                    <Input
                      id="policy-shipping"
                      type="number"
                      min={0}
                      step="0.01"
                      value={shippingCost}
                      aria-invalid={!postageValid}
                      aria-describedby={postageValid ? undefined : "policy-shipping-error"}
                      onChange={(e) => setShippingCost(e.target.value)}
                    />
                    {!postageValid && (
                      <p id="policy-shipping-error" className="text-xs text-destructive">
                        Enter an amount, or 0 for free postage.
                      </p>
                    )}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label className="text-xs">Returns</Label>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant={acceptsReturns ? "default" : "outline"}
                      aria-pressed={acceptsReturns}
                      onClick={() => setAcceptsReturns(true)}
                    >
                      I accept returns
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={acceptsReturns ? "outline" : "default"}
                      aria-pressed={!acceptsReturns}
                      onClick={() => setAcceptsReturns(false)}
                    >
                      No returns
                    </Button>
                  </div>
                  {acceptsReturns && (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <select
                        aria-label="Return window"
                        value={returnDays}
                        onChange={(e) => setReturnDays(e.target.value as "30" | "60")}
                        className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground [&>option]:bg-background [&>option]:text-foreground"
                      >
                        <option value="30">30 days to return</option>
                        <option value="60">60 days to return</option>
                      </select>
                      <select
                        aria-label="Who pays return postage"
                        value={returnPaidBy}
                        onChange={(e) =>
                          setReturnPaidBy(e.target.value as "BUYER" | "SELLER")
                        }
                        className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground [&>option]:bg-background [&>option]:text-foreground"
                      >
                        <option value="BUYER">Buyer pays return postage</option>
                        <option value="SELLER">I pay return postage</option>
                      </select>
                    </div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{policySummary}</p>
                <Button
                  onClick={() =>
                    createPolicies.mutate({
                      handling_days: handlingNum,
                      shipping_cost_cents: Math.round(postageNum * 100),
                      accepts_returns: acceptsReturns,
                      return_days: returnDays === "60" ? 60 : 30,
                      return_shipping_paid_by: returnPaidBy,
                    })
                  }
                  disabled={createPolicies.isPending || !handlingValid || !postageValid}
                >
                  {createPolicies.isPending && (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  )}
                  Create these for me
                </Button>
              </div>
            )}
            {policies.length > 0 && (
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
type StepState = "done" | "todo" | "blocked" | "loading" | "unknown";

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
        ) : state === "unknown" ? (
          <AlertCircle className="h-5 w-5 flex-shrink-0 text-muted-foreground" />
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
  connError,
  retryConnection,
}: {
  connection: EbayConnection | null | undefined;
  connLoading: boolean;
  /** The connection READ failed — distinct from there being no connection. */
  connError: boolean;
  retryConnection: () => void;
  syncing: boolean;
  onSync: (full: boolean) => void;
  onConnect: () => void;
  oauthPending: boolean;
}) {
  // US-3248: THREE states, not two. react-query leaves `data` undefined on a
  // failed read exactly as it does when there is genuinely no connection, so
  // `!!connection` told a connected seller they were disconnected — on the one
  // page whose job is answering that question — and offered them the Connect
  // button, which re-runs OAuth against a link that was working.
  const connected = !connError && !!connection;
  const disconnect = useDisconnectEbay();
  // MP-01: connecting, disconnecting and editing the location or policies all
  // change the owner's live eBay setup, and the edge refuses them below admin.
  const { can } = useWorkspace();
  const canManage = can("manage_marketplaces");
  const {
    data: policyData,
    isLoading: polLoading,
    isError: polError,
    refetch: refetchPolicies,
  } = useEbayPolicies(connected);
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
  const polReady = connected && !polLoading && !polError;
  // MP-07: a failed policies read is "couldn't check", not two todo steps.
  const checkAgain = (
    <Button size="sm" variant="outline" onClick={() => void refetchPolicies()}>
      Check again
    </Button>
  );

  return (
    <Card id="ebay-setup" className="scroll-mt-20">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <Plug className="h-5 w-5" />
            {allReady ? "eBay" : "Get ready to sell on eBay"}
          </CardTitle>
          {connError ? (
            <Badge variant="outline" className="border-destructive/50 text-destructive">
              Status unknown
            </Badge>
          ) : connected ? (
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
                <div
                  role="progressbar"
                  aria-label="eBay setup progress"
                  aria-valuemin={0}
                  aria-valuemax={3}
                  aria-valuenow={doneCount}
                  className="h-2 w-full overflow-hidden rounded-full bg-muted"
                >
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
                  !canManage ? undefined : connected ? (
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={onConnect}
                        disabled={oauthPending}
                      >
                        Reconnect
                      </Button>
                      <DisconnectConfirm
                        channel="eBay"
                        account={connection?.account_handle}
                        consequence="Sales from eBay stop syncing, cross-listed items won't auto-end, and you can't publish until you reconnect."
                        pending={disconnect.isPending}
                        onConfirm={() =>
                          connection && disconnect.mutate({ connectionId: connection.id })
                        }
                      />
                    </div>
                  ) : (
                    connError ? (
                      // Never offer Connect while the state is unknown. Re-running
                      // OAuth against a live connection is the action this defect
                      // provokes, and the one thing the page must not invite.
                      <Button size="sm" variant="outline" onClick={retryConnection}>
                        Check again
                      </Button>
                    ) : (
                      <Button size="sm" onClick={onConnect} disabled={oauthPending}>
                        {oauthPending && (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        )}
                        Connect eBay
                      </Button>
                    )
                  )
                }
              />

              {/* 2 — ship-from location */}
              <StepRow
                state={
                  !connected
                    ? "blocked"
                    : polError
                      ? "unknown"
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
                    : polError
                      ? "Status unknown. Couldn't check."
                      : polLoading
                      ? "Checking…"
                      : hasLocation
                        ? "Set — used on every listing"
                        : "eBay needs a ship-from location to publish"
                }
                action={
                  connected && polError ? (
                    checkAgain
                  ) : polReady && canManage ? (
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
                    : polError
                      ? "unknown"
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
                    : polError
                      ? "Status unknown. Couldn't check."
                      : polLoading
                      ? "Checking…"
                      : hasPolicies
                        ? "Shipping, payment & return set"
                        : "Pick a shipping, payment & return default"
                }
                action={
                  connected && polError ? (
                    checkAgain
                  ) : polReady && canManage ? (
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

            {!canManage && (
              <p className="text-xs text-muted-foreground">{MARKETPLACE_ADMIN_ONLY}</p>
            )}

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
            {/*
              US-3111: say what "synced" actually covers. Not every field
              refreshes on the same clock, and a seller who assumes it does
              reads the slowest one as a bug — an ended listing taking a day to
              reach Drafts is the usual report. Stating the three cadences turns
              that into expected behaviour, and it is also the honest answer to
              anyone asking how hard we lean on eBay's API.
            */}
            <p className="text-[11px] text-muted-foreground">
              Sales, offers and returns arrive from eBay as they happen. Prices
              and quantities refresh every few hours. Listings that ended
              without selling move back to Drafts once a day.
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
  const {
    data: connection,
    isLoading,
    isError: connError,
    refetch: refetchConnection,
  } = useShopifyConnection();
  const startOauth = useStartShopifyOauth();
  const disconnect = useDisconnectShopify();
  const sync = useSyncShopify();
  const { can } = useWorkspace();
  const canManage = can("manage_marketplaces");
  const [shop, setShop] = useState("");
  // US-3248: see the eBay card. A failed read is not a missing connection.
  const connected = !connError && !!connection;

  const connect = () => {
    const trimmed = shop.trim();
    if (!trimmed) {
      toast.error("Enter your Shopify store domain (e.g. my-store.myshopify.com).");
      return;
    }
    startOauth.mutate({ shop: trimmed });
  };

  return (
    <Card id="shopify-setup" className="scroll-mt-20">
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
          ) : connError ? (
            <Badge variant="outline" className="border-destructive/50 text-destructive">
              Status unknown
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
        {connError ? (
          // US-3248: the connect form is the thing this defect provokes, so it
          // is the thing to withhold while the state is unknown.
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
          >
            <span>
              Couldn&apos;t check your Shopify connection. This is a loading
              problem, not a disconnection.
            </span>
            <Button size="sm" variant="outline" onClick={() => void refetchConnection()}>
              Check again
            </Button>
          </div>
        ) : !connected && !canManage ? (
          <p className="text-xs text-muted-foreground">{MARKETPLACE_ADMIN_ONLY}</p>
        ) : !connected ? (
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
            {canManage && (
              <DisconnectConfirm
                channel="Shopify"
                account={connection?.account_handle}
                consequence="Orders from Shopify stop syncing, cross-listed items won't auto-end, and you can't publish to Shopify until you reconnect."
                pending={disconnect.isPending}
                onConfirm={() => disconnect.mutate()}
              />
            )}
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
  const { data, isLoading, isError, isFetching, refetch } = useEbayPromotedOverview(true);
  const sync = useEbaySyncPromoted();

  const refresh = async () => {
    try {
      const r = await sync.mutateAsync();
      await qc.invalidateQueries({ queryKey: ["ebay_promoted_overview"] });
      toast.success(
        `Refreshed ${r.updated} of ${r.scanned} promoted listing${r.scanned === 1 ? "" : "s"}.`,
      );
    } catch (e) {
      toastError(e, "Couldn't refresh promoted listings.");
    }
  };

  const listings = data?.listings ?? [];
  const summary = data?.summary;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          {/* US-3032: "Running now", not "Promoted listings" — the suggestions
              card below carried the same name. The section heading owns the
              name; these two say which half they are. */}
          <CardTitle className="flex items-center gap-2 text-base">
            <Megaphone className="h-4 w-4" />
            Running now
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
          Every listing carrying an ad right now, and what it has cost. Set a
          listing&apos;s rate or opt it out from its item page.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading promoted listings…
          </div>
        ) : isError ? (
          // MP-11: not "No promoted listings yet".
          <ErrorState
            className="py-6"
            title="Couldn't load promoted listings"
            description="This is a loading problem, not an empty list."
            onRetry={() => void refetch()}
            retrying={isFetching}
            hideSupport
          />
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
  // US-3071: and the whole four-flow row beneath it.
  const flows =
    MARKETPLACE_EXTENSION_FLOWS[
      platform as keyof typeof MARKETPLACE_EXTENSION_FLOWS
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
      {/* US-3071: what this channel does FOR the seller, and what they still do
          themselves. Read straight from MARKETPLACE_EXTENSION_FLOWS, which
          marketplace-mechanism.test.ts pins to the shipped selectors — so the
          page cannot promise a flow the extension has switched off. Before
          this, the card showed the LIST flow's badge and nothing about delist,
          revise or relist, which is how three channels can be switched on with
          nothing on screen saying so. */}
      {flows && (
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {(["list", "delist", "revise", "relist"] as const).map((flow) => (
            <li
              key={flow}
              className={
                flows[flow] === "live"
                  ? "text-[11px] font-medium text-foreground"
                  : "text-[11px] text-muted-foreground"
              }
            >
              {MARKETPLACE_FLOW_CAPABILITY_LABEL[flow][flows[flow]]}
            </li>
          ))}
        </ul>
      )}
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

// US-2481: work queued from a phone, waiting for this desktop.
//
// The honest counterpart to the queue itself. Nifty's pitch is that your work
// runs whether or not your browser is open; ours is that it runs in YOUR
// browser, which means there is a wait — and the only way that is a feature
// rather than a disappointment is if the wait is stated rather than discovered.
//
// The second list is the one that earns its place: work that expired undrained.
// A seller who believes a delist is still pending is a seller heading for a
// double sale, so an item that never ran surfaces here instead of aging out in
// silence (US-2481 AC6, the same rule as the US-2165 delist marker).
// US-2699: sold-sync health, and the queue of things it refused to decide alone.
//
// The status here comes from the SAME projection the extension popup reads
// (lib/sync-status.ts). Two surfaces disagreeing about whether a channel is
// healthy is the failure lib/pending-delists.ts documents, and it is worse here
// than there: sold-sync is the thing standing between a seller and a double
// sale, so a seller who cannot tell whether it is running does not trust it.
// US-2701 AC3: the scheduled poll's off switch, reachable from the web as well
// as the popup.
//
// It can stop the poll and change its cadence. It cannot START it: accepting the
// clickwrap happens in the extension, where the terms render from the
// extension's own copy. Saying that on screen matters more than hiding it —
// a seller who cannot find the on switch should be told where it is, not left
// to conclude the feature is broken.
// US-2699 AC5: link an unmatched sale to one of the seller's listings.
//
// The payoff is the sentence in the group blurb: do this once and every later
// sighting of that address matches on its own. It is asserted end to end in
// marketplace-observations_test.ts, not just implied by the column write.
function ClaimControl({ review }: { review: SyncReview }) {
  const [open, setOpen] = useState(false);
  const claim = useClaimSyncReview();
  const {
    data: candidates,
    isLoading,
    isError,
    refetch,
  } = useClaimCandidates(open ? review.id : null);

  if (!open) {
    return (
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        Link to an item
      </Button>
    );
  }

  if (isError) {
    // MP-08: an empty picker read as "no listings to link to".
    return (
      <span role="alert" className="flex items-center gap-1 text-xs">
        Couldn&apos;t load your listings.
        <Button variant="ghost" size="sm" onClick={() => void refetch()}>
          Retry
        </Button>
      </span>
    );
  }

  return (
    <select
      aria-label={`Link ${review.title ?? "this sale"} to one of your listings`}
      className="h-8 max-w-[16rem] rounded-md border bg-background px-2 text-xs"
      defaultValue=""
      disabled={isLoading || claim.isPending}
      onChange={(e) => {
        if (!e.target.value) return;
        claim.mutate(
          { reviewId: review.id, listingId: e.target.value },
          { onSuccess: claimToast, onError: (err) => toastError(err) },
        );
      }}
    >
      <option value="">{isLoading ? "Loading your listings..." : "Choose an item"}</option>
      {!isLoading && (candidates ?? []).length === 0 && (
        <option value="" disabled>
          No unlinked active listings on this channel
        </option>
      )}
      {(candidates ?? []).map((c: ClaimCandidate) => (
        <option key={c.id} value={c.id}>
          {c.listing_title ?? "Untitled listing"}
          {c.listing_price != null ? ` ($${Number(c.listing_price).toFixed(2)})` : ""}
        </option>
      ))}
    </select>
  );
}

// MP-09: the claim links the listing even when the review row could not be
// cleared, and that row sitting open afterwards reads like the link failed.
function claimToast(res: { review_resolved?: boolean }) {
  if (res.review_resolved === false) {
    toast.warning("Linked, but this row could not be cleared. Dismiss it.");
  } else {
    toast.success("Linked. The next sale on this listing matches by itself.");
  }
}

// MP-09: a sale matched to one of the seller's items, short of the certainty to
// act alone. The group copy asks them to confirm; this is the button that does.
function ConfirmMatch({ review }: { review: SyncReview }) {
  const claim = useClaimSyncReview();
  if (!review.listing_id) return null;
  const listingId = review.listing_id;
  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={`Yes, ${review.title ?? "this sale"} is this item`}
      disabled={claim.isPending}
      onClick={() =>
        claim.mutate(
          { reviewId: review.id, listingId },
          { onSuccess: claimToast, onError: (err) => toastError(err) },
        )
      }
    >
      Yes, this item
    </Button>
  );
}

// US-2701 AC7: a channel the poll stopped because the marketplace asked for a
// human check.
//
// The quietest failure in the feature. The poll stays switched on, no error
// appears anywhere, and that channel never runs again until the seller opens it
// themselves. Resuming is a button and not a timer, because GradeThread never
// decides a human check has passed.
function StoppedChannels({
  platforms,
  alreadyShown,
}: {
  platforms: string[];
  /** MP-14: channels the status rows above already show as stopped. */
  alreadyShown: ReadonlySet<string>;
}) {
  const fresh = platforms.filter((p) => !alreadyShown.has(p));
  if (fresh.length === 0) return null;
  return (
    <div className="mt-3 rounded-lg border border-dashed p-3">
      {fresh.map((platform) => {
        const copy = stoppedChannelCopy(platform);
        return (
          <div key={platform}>
            <p className="text-sm font-medium text-brand-red-text">{copy.label}</p>
            <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">{copy.detail}</p>
          </div>
        );
      })}
    </div>
  );
}

function SoldSyncSchedule({
  poll,
  isLoading,
  stoppedInRows,
}: {
  poll: ReturnType<typeof usePollState>["data"];
  isLoading: boolean;
  stoppedInRows: ReadonlySet<string>;
}) {
  const stop = useStopPoll();
  const setInterval = useSetPollInterval();

  // No extension, or an older one: say nothing rather than showing a control
  // that cannot work.
  if (isLoading || !poll || !poll.available) return null;

  const stopped = poll.stoppedChannels ?? [];

  if (!poll.accepted || !poll.enabled) {
    return (
      <div className="mt-3 rounded-lg border border-dashed p-3">
        <p className="text-sm font-medium">Scheduled checks are off</p>
        <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">
          Sold-sync currently reads your sold pages only while you are on them.
          To have GradeThread check on its own, open the extension and accept the
          short list of what it will do. That has to happen in the extension so
          you are agreeing to its wording, not ours.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Checking on a schedule</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            One channel at a time, in a background tab, while your browser is open.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-muted-foreground" htmlFor="pollEvery">
            Every
          </label>
          <select
            id="pollEvery"
            className="h-8 rounded-md border bg-background px-2 text-xs"
            value={poll.intervalMin}
            disabled={setInterval.isPending}
            onChange={(e) => {
              setInterval.mutate(Number(e.target.value), {
                onError: (err) => toastError(err),
              });
            }}
          >
            {POLL_INTERVAL_CHOICES.map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? "" : "s"}`}
              </option>
            ))}
          </select>
          <Button
            variant="ghost"
            size="sm"
            disabled={stop.isPending}
            onClick={() => {
              stop.mutate(undefined, {
                onSuccess: () => toast.success("Scheduled checks turned off."),
                onError: (err) => toastError(err),
              });
            }}
          >
            Turn off
          </Button>
        </div>
      </div>
      <StoppedChannels platforms={stopped} alreadyShown={stoppedInRows} />
    </div>
  );
}

function SoldSyncSection() {
  const {
    data: channels,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useSyncStatus();
  const {
    data: reviews,
    isError: reviewsError,
    refetch: refetchReviews,
  } = useSyncReviews();
  const dismiss = useDismissSyncReview();
  // MP-14: lifted here so the blurb can say whether reads also run on a
  // schedule. It used to say "Nothing is read on a schedule" directly above
  // "Checking on a schedule".
  const { data: poll, isLoading: pollLoading } = usePollState();
  const scheduled = !!poll?.available && !!poll.accepted && !!poll.enabled;

  const rows = channels ?? [];
  const stoppedInRows = new Set(rows.filter((r) => r.status === "stopped").map((r) => r.platform));
  // MP-08: this is the double-sale guard. A failed status read used to hide
  // the whole section, which reads exactly like "no channel to guard".
  if (isError) {
    return (
      <div>
        <h3 className="mb-1 text-sm font-semibold text-foreground">Sold-sync</h3>
        <ErrorState
          className="rounded-lg border py-6"
          title="Couldn't check sold-sync"
          description="We could not read whether your channels are being watched for sales. This is a loading problem, not a stopped sync."
          onRetry={() => void refetch()}
          retrying={isFetching}
          hideSupport
        />
      </div>
    );
  }
  if (isLoading || rows.length === 0) return null;

  const queue = reviews ?? [];
  const groups = REVIEW_GROUP_ORDER;

  const toneClass = (tone: string) =>
    tone === "warn"
      ? "text-brand-red-text"
      : tone === "ok"
        ? "text-foreground"
        : "text-muted-foreground";

  return (
    // US-3032: h3 and <div>, not h2 and <section>. This is one part of the
    // "Browser extension" section now, not a peer of "Active".
    <div>
      <h3 className="mb-1 text-sm font-semibold text-foreground">
        Sold-sync
      </h3>
      <p className="mb-3 max-w-prose text-xs text-muted-foreground">
        When one of these channels sells a garment, GradeThread ends your other
        listings for it so the same item cannot sell twice. It reads your own
        sold page while you are on it, from your browser.{" "}
        {scheduled
          ? "It also checks on the schedule below while your browser is open."
          : "Nothing is read on a schedule."}{" "}
        GradeThread never receives your marketplace password, session, or the
        name or address of anyone who bought from you.
      </p>

      <div className="rounded-lg border">
        <ul className="divide-y">
          {rows.map((ch) => {
            const copy = syncStateCopy(ch);
            return (
              <li
                key={ch.platform}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 p-3"
              >
                <span className="text-sm font-medium">
                  {MARKETPLACE_LABELS[
                    ch.platform as keyof typeof MARKETPLACE_LABELS
                  ] ?? ch.platform}
                </span>
                <span className="flex flex-1 flex-wrap items-baseline justify-end gap-x-3 gap-y-0.5 text-xs">
                  {copy.detail && (
                    <span className="text-muted-foreground">{copy.detail}</span>
                  )}
                  {ch.open_reviews > 0 && (
                    <span className="text-muted-foreground">
                      {ch.open_reviews} to review
                    </span>
                  )}
                  <span className={`font-medium ${toneClass(copy.tone)}`}>
                    {copy.label}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <SoldSyncSchedule poll={poll} isLoading={pollLoading} stoppedInRows={stoppedInRows} />

      {reviewsError && (
        <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span>Couldn&apos;t load the sales waiting for your review.</span>
          <Button variant="outline" size="sm" onClick={() => void refetchReviews()}>
            Retry
          </Button>
        </div>
      )}

      {queue.length > 0 && (
        <div className="mt-3 space-y-3">
          {groups.map((reason: ReviewGroup) => {
            // Derived, so an unmatched sale and a probable match stop sharing
            // a heading. See reviewGroupOf for why this is not a stored column.
            const items = queue.filter((r: SyncReview) => reviewGroupOf(r) === reason);
            if (items.length === 0) return null;
            const copy = groupCopy(reason);
            return (
              <div key={reason} className="rounded-lg border border-dashed p-3">
                <p className="text-sm font-medium">{copy.title}</p>
                <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">
                  {copy.blurb}
                </p>
                <ul className="mt-2 space-y-1.5">
                  {items.map((r: SyncReview) => (
                    <li
                      key={r.id}
                      className="flex flex-wrap items-center justify-between gap-2 text-xs"
                    >
                      <span className="text-muted-foreground">
                        <span className="font-medium text-foreground">
                          {r.title ?? "Untitled listing"}
                        </span>
                        {" on "}
                        {MARKETPLACE_LABELS[
                          r.platform as keyof typeof MARKETPLACE_LABELS
                        ] ?? r.platform}
                        {r.sold_price_cents != null
                          ? `, sold for $${(r.sold_price_cents / 100).toFixed(2)}`
                          : ""}
                        {r.sold_at ? ` on ${new Date(r.sold_at).toLocaleDateString()}` : ""}
                        {r.unexplained != null
                          ? `, ${r.unexplained} unaccounted for`
                          : ""}
                        {r.claimed != null && r.cap != null
                          ? `, claimed ${r.claimed}, cap ${r.cap}`
                          : ""}
                        {safeHref(r.listing_url) && (
                          <>
                            {" "}
                            <a
                              href={safeHref(r.listing_url) ?? undefined}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="underline underline-offset-2"
                            >
                              Open on{" "}
                              {MARKETPLACE_LABELS[
                                r.platform as keyof typeof MARKETPLACE_LABELS
                              ] ?? r.platform}
                            </a>
                          </>
                        )}
                      </span>
                      <span className="flex items-center gap-1">
                        {reason === "needs_confirming" && <ConfirmMatch review={r} />}
                        {/* The claim writes the sale's address onto the
                            listing; a row with no address has nothing to claim
                            and the server answers 422. */}
                        {reason === "unmatched" && r.listing_url && (
                          <ClaimControl review={r} />
                        )}
                        <Button
                        aria-label={`Dismiss ${r.title ?? "the untitled listing"}`}
                          variant="ghost"
                          size="sm"
                          disabled={dismiss.isPending}
                          onClick={() => {
                            dismiss.mutate(r.id, {
                              onSuccess: () => toast.success("Cleared."),
                              onError: (e) => toastError(e),
                            });
                          }}
                        >
                          Dismiss
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * US-3198: when the desktop last took work off the queue, and what is waiting
 * on which channel.
 *
 * This renders even when the queue is EMPTY, which is the whole point. Until
 * now the section returned null with nothing outstanding, so "you have no
 * queued work" and "no extension has ever drained your queue" produced the
 * identical blank screen. The first is fine and the second is a stalled seller
 * who will not find out until an item sells in two places.
 */
// MP-15: how long a desktop can go without draining before pending work is
// called out as stalled.
const STALLED_DRAIN_MS = 24 * 60 * 60 * 1000;

function QueueSummary({
  pending,
  lastDrainedAt,
}: {
  pending: ExtensionQueueItem[];
  lastDrainedAt: string | null;
}) {
  const qc = useQueryClient();
  const groups = groupQueue(pending);
  const drained = lastDrainedAt ? new Date(lastDrainedAt) : null;
  const drainedValid = drained && !Number.isNaN(drained.getTime()) ? drained : null;
  const [running, setRunning] = useState(false);
  // MP-15: requestDrainNow() and the extension's GT_DRAIN_NOW already existed;
  // the page that shows the queue had no button for them, so a seller waited
  // for the 5-minute alarm.
  const canRunNow = pending.length > 0 && isListerAvailable();
  const stalled =
    pending.length > 0 &&
    (!drainedValid || Date.now() - drainedValid.getTime() > STALLED_DRAIN_MS);

  const runNow = async () => {
    setRunning(true);
    try {
      const result = await requestDrainNow();
      const sentence = drainNudgeSentence(result);
      if (result.state === "ok" || result.state === "empty" || result.state === "busy") {
        toast.success(sentence);
      } else {
        toast.info(sentence);
      }
      await qc.invalidateQueries({ queryKey: ["extension_queue"] });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mb-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm font-medium">
          {pending.length === 0
            ? "Nothing waiting for your desktop"
            : `${pending.length} job${pending.length === 1 ? "" : "s"} waiting for your desktop`}
        </p>
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground" title={drainedValid?.toLocaleString()}>
            {drainedValid
              ? `Last run ${formatAgo(drainedValid.toISOString())}`
              : "Your extension has never run any of this"}
          </span>
          {canRunNow && (
            <Button size="sm" variant="outline" onClick={() => void runNow()} disabled={running}>
              {running && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Run now
            </Button>
          )}
        </span>
      </div>

      {stalled && (
        <p role="status" className="mt-2 text-xs text-brand-red-text">
          {drainedValid
            ? `Your desktop has not picked up work since ${formatAgo(drainedValid.toISOString())}.`
            : "Your desktop has never picked up work."}{" "}
          Open Chrome with the extension.
        </p>
      )}

      {groups.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {groups.map((g) => {
            const label =
              MARKETPLACE_LABELS[g.platform as keyof typeof MARKETPLACE_LABELS] ?? g.platform;
            // Named in the order that matters to a seller, not alphabetically:
            // a queued delist means the garment is live in two places right
            // now, so it leads.
            const parts = [
              g.kinds.delist > 0 ? `${g.kinds.delist} to end` : null,
              g.kinds.list > 0 ? `${g.kinds.list} to list` : null,
              g.kinds.revise > 0 ? `${g.kinds.revise} to update` : null,
              g.kinds.relist > 0 ? `${g.kinds.relist} to relist` : null,
            ].filter((x): x is string => x !== null);
            return (
              <li key={g.platform} className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{label}</span>{" "}
                {parts.join(", ")}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ExtensionQueueSection() {
  const { data, isLoading, isError, isFetching, refetch } = useExtensionQueue();
  const { hash } = useLocation();
  const headingRef = useRef<HTMLHeadingElement>(null);
  // MP-14: the attention rail links here. Scroll once the queue has settled,
  // so the layout below does not jump the section away again, and move focus
  // to the heading so a keyboard or screen-reader user lands on it too.
  useEffect(() => {
    if (hash !== "#extension-queue" || isLoading) return;
    const el = document.getElementById("extension-queue");
    el?.scrollIntoView({ block: "start" });
    headingRef.current?.focus();
  }, [hash, isLoading]);
  const cancel = useCancelExtensionWork();
  const requeue = useRequeueExtensionWork();
  // MP-10: only the row being acted on is busy, not every row on the list.
  const busyId =
    (cancel.isPending ? cancel.variables : undefined) ??
    (requeue.isPending ? requeue.variables?.id : undefined);

  const pending = data?.pending ?? [];
  const needsAttention = data?.needsAttention ?? [];
  // US-3425: runs that FINISHED and still want a human. The edge has answered
  // with this since US-3370 and no web surface read it.
  const finished = data?.finishedNeedsReview ?? [];
  // US-3198: the empty guard is gone. QueueSummary is the thing a seller with
  // an empty queue needs to see.
  // MP-08: loading and error keep the heading and the #extension-queue anchor,
  // so the attention rail's link lands somewhere, and a failed read is never
  // "Nothing waiting for your desktop".
  if (isLoading || isError) {
    return (
      <div id="extension-queue" className="scroll-mt-20">
        <h3 className="mb-3 text-sm font-semibold text-foreground">
          Queued for your desktop
        </h3>
        {isError ? (
          <ErrorState
            className="rounded-lg border py-6"
            title="Couldn't load your queued work"
            description="This is a loading problem. Anything you queued is still queued."
            onRetry={() => void refetch()}
            retrying={isFetching}
            hideSupport
          />
        ) : (
          <Skeleton className="h-16 w-full" />
        )}
      </div>
    );
  }

  const describe = (kind: string, platform: string) => {
    const label = MARKETPLACE_LABELS[platform as keyof typeof MARKETPLACE_LABELS] ?? platform;
    // No `share` branch: US-2497 removed the kind and deleted its rows, because
    // a share run needs a human at the browser and a queue cannot supply one.
    if (kind === "delist") return `End the ${label} listing`;
    // US-3048: revise and relist have been queueable kinds since US-9202/9203
    // and both fell through to "List to ...". A seller who queued a price
    // change was told their item was about to be listed a second time.
    if (kind === "revise") return `Update the ${label} listing`;
    if (kind === "relist") return `Relist on ${label}`;
    return `List to ${label}`;
  };

  return (
    // US-3032: h3 and <div> — a part of the "Browser extension" section.
    // The id is the attention rail's extension chips' anchor.
    <div id="extension-queue" className="scroll-mt-20">
      <h3 ref={headingRef} tabIndex={-1} className="mb-3 text-sm font-semibold text-foreground">
        Queued for your desktop
      </h3>

      <QueueSummary pending={pending} lastDrainedAt={data?.lastDrainedAt ?? null} />

      {pending.length > 0 && (
        <div className="rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">{QUEUED_NOTICE}</p>
          <ul className="mt-3 space-y-2">
            {pending.map((job) => (
              <li
                key={job.id}
                className="flex flex-wrap items-center justify-between gap-2 text-sm"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    {/* US-3048: name the item. Four rows all reading "List to
                        Poshmark" gave a seller no way to tell which one they
                        wanted to cancel. item_title is joined on by GET / and
                        is genuinely absent for some rows, so the verb stays as
                        the fallback rather than a placeholder. */}
                    <span className="block truncate font-medium">
                      {job.item_title ?? describe(job.kind, job.platform)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {job.item_title ? `${describe(job.kind, job.platform)} · ` : ""}
                      queued {formatAgo(job.created_at)}
                      {job.source !== "web" ? " from your phone" : ""}
                    </span>
                  </span>
                </span>
                {/* US-3048: Cancel on a QUEUED row only.
                    `pending` holds claimed rows too, and a claimed row is a job
                    with a marketplace tab open on it at this moment. Deleting it
                    leaves a half-filled form and nothing server-side that
                    remembers it was ever asked for. The extension's popup draws
                    the same line (queue/queue-view.js canCancel). */}
                {job.status === "claimed" ? (
                  <span className="shrink-0 text-xs font-medium text-muted-foreground">
                    Running now
                  </span>
                ) : (
                  <Button
                    aria-label={`Cancel ${describe(job.kind, job.platform)}${
                      job.item_title ? ` for ${job.item_title}` : ""
                    }`}
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    disabled={busyId === job.id}
                    onClick={() => {
                      cancel.mutate(job.id, {
                        onSuccess: () => toast.success("Removed from the queue."),
                        onError: (e) => toastError(e),
                      });
                    }}
                  >
                    Cancel
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {needsAttention.length > 0 && (
        <div className="mt-2 rounded-lg border border-dashed p-3">
          <p className="flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="h-4 w-4 text-brand-red-text" />
            Didn&apos;t run
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            These waited for a desktop browser that never opened, or failed when
            they ran. Nothing happened on the marketplace — do it there yourself,
            or queue it again.
          </p>
          <ul className="mt-2 space-y-1.5">
            {needsAttention.map((job) => {
              const name = job.item_title
                ? `${job.item_title}: ${describe(job.kind, job.platform)}`
                : describe(job.kind, job.platform);
              return (
                <li
                  key={job.id}
                  className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"
                >
                  <span>
                    <span className="font-medium text-foreground">{name}</span>
                    {job.result?.error ? `. ${job.result.error}` : ""}
                  </span>
                  {/* MP-10: these rows used to stay forever with no way to act
                      on them from here. */}
                  <span className="flex shrink-0 items-center gap-1">
                    {canRequeue(job) && (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`Queue again: ${name}`}
                      disabled={busyId === job.id}
                      onClick={() =>
                        requeue.mutate(job, {
                          onSuccess: () => toast.success("Queued again."),
                          onError: (e) => toastError(e),
                        })
                      }
                    >
                      Queue again
                    </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Dismiss: ${name}`}
                      disabled={busyId === job.id}
                      onClick={() =>
                        cancel.mutate(job.id, {
                          onSuccess: () => toast.success("Cleared."),
                          onError: (e) => toastError(e),
                        })
                      }
                    >
                      Dismiss
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* US-3425: it RAN. Its own words, because both lists above would be
          wrong about it and one of them dangerously so — "Nothing happened on
          the marketplace, queue it again" after a run that happened is how a
          seller posts the same garment twice. */}
      {finished.length > 0 && (
        <div className="mt-2 rounded-lg border p-3">
          <p className="flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="h-4 w-4 text-brand-red-text" />
            Ran, and needs you
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            These reached the marketplace. Something on them still needs
            fixing there — do not queue them again, or you will post twice.
          </p>
          <ul className="mt-2 space-y-1.5">
            {finished.map((job) => {
              const note = finishedRunNote(job.platform, job.result);
              return (
                <li key={job.id} className="text-xs">
                  <span className="font-medium text-foreground">
                    {job.item_title
                      ? `${job.item_title} — ${describe(job.kind, job.platform)}`
                      : describe(job.kind, job.platform)}
                  </span>
                  <span
                    className={
                      note.severity === "alarm"
                        ? "text-brand-red-text"
                        : "text-muted-foreground"
                    }
                  >
                    {" "}
                    {note.sentence}
                  </span>
                  {note.href && (
                    <a
                      href={note.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-1 underline underline-offset-2"
                    >
                      Open on {marketplaceLabel(job.platform)}
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
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
  const {
    data: connection,
    isLoading: connLoading,
    isError: connError,
    refetch: refetchConnection,
  } = useEbayConnection(pollingInterval);
  const { data: connIssue } = useEbayConnectionIssue();
  const startOauth = useStartEbayOauth();
  const syncListings = useSyncEbayListings();
  const { can } = useWorkspace();
  const canManage = can("manage_marketplaces");

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
    if (ebayCode) show(CALLBACK_MESSAGES[ebayCode] ?? CALLBACK_FALLBACK);
    // US-3458: the callback started the first pull server-side, so watch for
    // it the same way a Sync click does. `before` is whatever this page last
    // saw; a reconnect resets the server's cursor to null, so the first stamp
    // after connect always reads as a change and the completion toast fires.
    if (ebayCode === "connected" && !syncBaseline) {
      setSyncBaseline({ before: connection?.last_synced_at ?? null });
      syncToastId.current = toast.loading("Importing your eBay listings…", {
        description:
          "Live listings become FlipDesk items automatically. Ones that look like an item you already have wait on Reconciliation.",
        duration: Infinity,
      });
    }
    if (shopifyCode) {
      show(SHOPIFY_CALLBACK_MESSAGES[shopifyCode] ?? SHOPIFY_CALLBACK_FALLBACK);
    }
    const next = new URLSearchParams(params);
    next.delete("ebay");
    next.delete("shopify");
    setParams(next, { replace: true });
    // The two extra deps are read only on the `connected` branch above; once
    // the params are stripped the early return makes every re-run a no-op.
  }, [params, setParams, connection?.last_synced_at, syncBaseline]);

  const syncing = syncListings.isPending || syncBaseline != null;
  const { hash } = useLocation();
  const anchor = hash.replace(/^#/, "");
  const tabParam = params.get("tab");
  const tab = CONNECTIONS_ANCHORS.has(anchor)
    ? "connections"
    : TABS.includes(tabParam as (typeof TABS)[number])
      ? (tabParam as string)
      : DEFAULT_TAB;
  const setTab = (next: string) => {
    const p = new URLSearchParams(params);
    p.set("tab", next);
    setParams(p, { replace: true });
  };
  // MP-14: the summary rows link to #ebay-setup and #shopify-setup. The queue
  // anchor scrolls itself once its data settles (ExtensionQueueSection).
  useEffect(() => {
    if (anchor !== "ebay-setup" && anchor !== "shopify-setup") return;
    document.getElementById(anchor)?.scrollIntoView({ block: "start" });
  }, [anchor]);
  // MP-07: a failed read, a pending read and a real "not connected" are three
  // different answers in the Ads and Settings tabs too.
  const connCouldNotCheck = (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed p-4 text-sm"
    >
      <span>
        Couldn&apos;t check your eBay connection. This is a loading problem, not
        a disconnection.
      </span>
      <Button size="sm" variant="outline" onClick={() => void refetchConnection()}>
        Retry
      </Button>
    </div>
  );
  const connectPrompt = (text: string) => (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
      <span>{text}</span>
      <Button size="sm" variant="outline" onClick={() => setTab("connections")}>
        Go to Connections
      </Button>
    </div>
  );

  // Per-user FlipDesk behavior settings (migration 00134). Absent row =
  // defaults (auto-end ON), so the toggle reads that until the user changes it.
  const user = useAuthStore((s) => s.user);
  // MP-06: flipdesk_settings is per-user (RLS 00134) and the edge reads the
  // OWNER's row, so inside someone else's workspace a change here saved to a
  // row nothing reads. The control is withheld there instead.
  const ownSettings = useOwnsActiveWorkspace();
  const {
    data: fdSettings,
    isLoading: fdLoading,
    isError: fdError,
    refetch: refetchFdSettings,
  } = useQuery({
    queryKey: ["flipdesk_settings", user?.id],
    enabled: !!user && ownSettings,
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
    if (!user || !ownSettings || autoEndSetting === undefined) return;
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
          : "Auto-end is off. End the other listings yourself after a sale.",
      );
    } catch (err) {
      toastError(err, "Couldn't save the setting.");
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
              actions={<HelpLink slug="connecting-a-marketplace" label="Help: connecting a marketplace" />}
      />

      {/* US-463: a connection deactivated by a permanent token-refresh failure
          (revoked/expired grant) needs explicit re-auth. Show a clear banner
          with a reconnect action rather than silently reverting to the
          "Connect eBay" CTA. */}
      {isReauthNeeded(connIssue) && (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" />
            <span className="text-foreground">{reauthMessage(connIssue?.refresh_error)}</span>
          </div>
          {canManage ? (
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
          ) : (
            <span className="text-xs text-muted-foreground">{MARKETPLACE_ADMIN_ONLY}</span>
          )}
        </div>
      )}

      {/* US-2543 AC3: which platforms am I connected to, answered before any of
          the eight sections below. */}
      <MarketplaceConnectionSummary
        extensionChannelCount={EXTENSION_CHANNELS.length}
      />

      {/* US-2543 AC2: eight stacked sections meant scrolling past five pages of
          reference copy to reach a switch. The doing is in Connections, the
          settings are in Settings, and the disclosures are reference material
          that no longer sits between them.

          US-3032 added the fourth tab. Connections had picked up seven eBay
          advertising cards — ads, campaign suggestions, keywords, promotions,
          lift, follower email, account programs — which is a whole subject with
          its own money in it, and none of it is a connection. Splitting it out
          takes Connections back to what its name promises, and puts every card
          that spends money on eBay where they can be read against each other.
          The programs card went to Settings, which is what it always was. */}
      <Tabs value={tab} onValueChange={setTab} className="space-y-6">
        {/* MP-14: four triggers overflow at 375px. Short labels below sm, and
            the list scrolls sideways rather than pushing the page wider. */}
        <TabsList className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="connections">Connections</TabsTrigger>
          <TabsTrigger value="ads">
            <span className="sm:hidden">Ads</span>
            <span className="hidden sm:inline">Ads &amp; promotions</span>
          </TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="how">
            <span className="sm:hidden">How it works</span>
            <span className="hidden sm:inline">How channels work</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="connections" className="space-y-8">
      {/* Active — eBay setup + sync */}
      <section>
        <h2 className="mb-3 text-base font-semibold text-foreground">
          Active
        </h2>
        <div className="space-y-4">
          <EbaySetup
            connection={connection}
            connLoading={connLoading}
            syncing={syncing}
            onSync={runSync}
            onConnect={() => startOauth.mutate()}
            connError={connError}
            retryConnection={() => void refetchConnection()}
            oauthPending={startOauth.isPending}
          />
          <ShopifySetup />
        </div>
      </section>

      {/* More ways to sync — Google Sheets + CSV fallback */}
      <section>
        <h2 className="mb-3 text-base font-semibold text-foreground">
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

      {/* US-718: extension tier — Poshmark/Mercari/Grailed have no public write
          API, so they're listed from the seller's own logged-in tab via the
          GradeThread Lister browser extension (US-716). Presented honestly as a
          real, available capability — not "coming soon".

          US-3032: this was FOUR top-level sections — "Sold-sync", "Queued for
          your desktop", "Set up cross-posting" and "Connect via browser
          extension" — sitting at the same level as "Active" and "Coming soon",
          in that order. Every one of them is the same extension, and two of the
          four hide themselves when empty, so the page's outline changed shape
          depending on whether anything was queued. One section now, in the
          order a seller meets it: install it, see what it owes you, see what it
          brought back, read what each channel costs you. */}
      <section>
        <h2 className="mb-1 text-base font-semibold text-foreground">
          Browser extension
        </h2>
        <div className="mb-4 flex items-start gap-3 rounded-lg border p-3">
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
              These platforms have no public listing API, so the extension
              cross-lists a finished draft straight from your own logged-in tab
              — title, photos, price and the grade badge are filled in for you.
              Each channel below states what that means for your account.
            </p>
          </div>
        </div>

        <div className="space-y-6">
          {/* US-2719: the steps, before anything that depends on them. The
              paragraph above used to carry the only install instruction on the
              page and it was not a link — a seller was told to install
              something and given nowhere to do it. The instruction lives in the
              setup steps, which know what is already done. */}
          <CrossPostSetup />

          {/* US-2481: what your phone queued and this desktop has not run yet. */}
          <ExtensionQueueSection />

          {/* US-3197: one garment listed on two channels, joined onto one
              item. Here rather than on the import page because it is about
              what is already in FlipDesk, not about getting more in. */}
          <LinkDuplicatesCard />

          <SoldSyncSection />

          <div>
            <h3 className="mb-3 text-sm font-semibold text-foreground">
              What each channel means for your account
            </h3>
            {/* US-2475: one risk block per channel, driven by MARKETPLACE_MECHANISM. */}
            <div className="space-y-2">
              {EXTENSION_CHANNELS.map((m) => (
                <ChannelRisk key={m} platform={m} />
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Coming soon — api_pending (connector built, awaiting approval) +
          channels with no integration yet. Muted rows, never a fake connect
          flow for an unbuilt API path. */}
      <section>
        <h2 className="mb-3 text-base font-semibold text-foreground">
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
        </TabsContent>

        {/* US-3032. Everything here spends money on eBay, so it is read
            together or not at all. Gated once on the connection rather than per
            card: five cards each saying "connect eBay first" is the state this
            replaced. */}
        <TabsContent value="ads" className="space-y-8">
          {connLoading ? (
            // Nothing, not the prompt below: telling a connected seller to go
            // and connect eBay for the half-second before the query answers is
            // worse than an empty tab.
            <div className="h-4" />
          ) : connError ? (
            connCouldNotCheck
          ) : !connection ? (
            connectPrompt(
              "Connect eBay on the Connections tab and your ads, sales and follower emails show up here.",
            )
          ) : (
            <>
              <section>
                <h2 className="mb-1 text-base font-semibold text-foreground">
                  Promoted Listings
                </h2>
                <p className="mb-3 max-w-prose text-xs text-muted-foreground">
                  A Cost-Per-Sale ad: eBay charges the ad rate only when the item
                  sells through the ad, never up front. What is running now,
                  then what eBay thinks is worth adding.
                </p>
                <div className="space-y-4">
                  <PromotedListingsSection />
                  {/* US-2946/2947: what to promote, and the controls to stop it. */}
                  <EbayCampaignCard />
                  {/* US-2945: keywords are the only lever a cost-per-click
                      campaign has, so they sit with the campaign rather than on
                      a connections list, where they answered no question a
                      seller was asking. */}
                  <EbayKeywordsCard />
                </div>
              </section>

              <section>
                <h2 className="mb-1 text-base font-semibold text-foreground">
                  Sales and discounts
                </h2>
                <p className="mb-3 max-w-prose text-xs text-muted-foreground">
                  Markdowns, coupons and volume discounts, and whether they
                  earned their keep.
                </p>
                <div className="space-y-4">
                  {/* US-1448: the seller's eBay Promotions Manager offers. */}
                  <EbayPromotionsCard />
                  {/* US-2949/2951: whether the sale worked, and whether the
                      discounts stack under cost. Renders nothing at all when it
                      has neither — see promotionPerformanceHasContent. */}
                  <PromotionPerformanceCard />
                </div>
              </section>

              <section>
                <h2 className="mb-3 text-base font-semibold text-foreground">
                  Your followers
                </h2>
                {/* US-2953: the audience the seller already owns and pays
                    nothing to reach. */}
                <FollowerCampaignCard />
              </section>
            </>
          )}
        </TabsContent>

        <TabsContent value="settings" className="space-y-8">
        {/* Cross-listing behavior (US-149) */}
        <section>
          <h2 className="mb-3 text-base font-semibold text-foreground">
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
              {!ownSettings && (
                <p className="text-xs text-muted-foreground">{SETTINGS_OWNER_ONLY}</p>
              )}
              {ownSettings && fdError && (
                <p role="alert" className="text-xs">
                  Couldn&apos;t load this setting.
                </p>
              )}
            </div>
            {!ownSettings ? (
              <Switch id="auto-end-cross" checked={false} disabled />
            ) : fdError ? (
              <Button size="sm" variant="outline" onClick={() => void refetchFdSettings()}>
                Retry
              </Button>
            ) : fdLoading || autoEndSetting === undefined ? (
              <Skeleton className="h-5 w-9 rounded-full" />
            ) : (
              <Switch
                id="auto-end-cross"
                checked={autoEndSetting}
                disabled={autoEndSaving}
                onCheckedChange={(v) => void toggleAutoEnd(v)}
              />
            )}
          </div>
          {/* US-2721: which channels a draft is offered at all. Beside the
              auto-end toggle because both answer "how does cross-listing
              behave for me", and both write the same per-user settings row. */}
          <div className="mt-3">
            <CrossPostChannelPicker />
          </div>
          {/* US-2777: which country domain each multi-domain channel opens.
              Directly under the channel picker: the two questions are "which
              marketplaces" and "which of their sites", and they write the same
              per-user settings row. */}
          <div className="mt-3">
            <ListerLocalePicker />
          </div>
        </section>

        {/* Grade authority signal — text only (eBay-policy pivot) */}
        <section>
          <h2 className="mb-3 text-base font-semibold text-foreground">
            Grade promotion
          </h2>
          {/* US-3060: the on-marketplace badge switch belongs here rather than
              under Cross-listing — both this and the text signal below answer
              "what does my grade do on the listing once it is live". */}
          <div className="mb-3">
            <ListingBadgeToggle />
          </div>
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

        {/* US-2157: eBay account-level program opt-in (out-of-stock control,
            business policy management).

            US-3032 moved it here from the connections list. Its own description
            calls it "account-level eBay settings that change how your listings
            behave", which is the definition of this tab and not of that one. */}
        <section>
          <h2 className="mb-3 text-base font-semibold text-foreground">
            eBay account programs
          </h2>
          {connLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : connError ? (
            connCouldNotCheck
          ) : connection ? (
            <EbayProgramsCard />
          ) : (
            connectPrompt("Connect eBay on the Connections tab to switch these on.")
          )}
        </section>
        </TabsContent>

        <TabsContent value="how" className="space-y-8">
        {/* US-2475: the same disclosure for the API-tier channels — a sanctioned
            developer connection is a different risk position from browser
            automation, and a seller comparing the two should be able to read both
            in the same words. */}
        <section>
          <h2 className="mb-3 text-base font-semibold text-foreground">
            How your API connections work
          </h2>
          <div className="space-y-2">
            {API_CHANNELS.map((m) => (
              <ChannelRisk key={m} platform={m} />
            ))}
          </div>
        </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}
