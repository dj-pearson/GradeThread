// The Referrals page's Affiliate tab: the earned-link funnel, channel-safe
// proof-of-grade copy, and (for admitted creators only) the cash payout card.
//
// Its own component so its two queries run only when the tab is open: Radix
// mounts a TabsContent's children only while that tab is active, so a seller
// who opens the page on Share makes no /api/affiliate/* request at all.

import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { Textarea } from "@/components/ui/textarea";
import { edgeFetch } from "@/lib/edge-fetch";
import { referralLink, affiliateBadgeEmbed } from "@/lib/affiliate";
import {
  EBAY_PROOF_LINE,
  MARKETPLACE_PROOF_LINE,
  PROOF_CHANNELS,
  type ProofChannel,
} from "@/lib/proof-of-grade";
import { CopyButton } from "@/components/referral/copy-button";
import { cn } from "@/lib/utils";
import {
  type AffiliatePayouts,
  payoutRateCopy,
  startPayoutOnboarding,
} from "@/lib/referral-page";
import { AlertCircle, BadgeCheck, Check, Circle, Wallet } from "lucide-react";

interface AffiliateMe {
  code: string;
  clicks: { total: number; last30: number; converted: number };
  conversions: number;
}

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

const PAYOUT_STATUS: Record<string, string> = {
  paid: "Paid",
  pending: "Sending",
  processing: "Sending",
  failed: "Failed",
  canceled: "Canceled",
};

function ProofOfGradeCard({ code }: { code: string }) {
  const [channel, setChannel] = useState<ProofChannel>("ebay");
  const badge = affiliateBadgeEmbed(code);
  const link = referralLink(code, "badge");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BadgeCheck className="h-5 w-5 text-brand-red-text" /> Show the grade where you sell
        </CardTitle>
        <CardDescription>
          Each place has its own rules. Pick where it's going and copy what's safe there.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div role="group" aria-label="Where it's going" className="flex flex-wrap gap-2">
          {PROOF_CHANNELS.map((c) => (
            <Button
              key={c.value}
              type="button"
              size="sm"
              variant={channel === c.value ? "default" : "outline"}
              aria-pressed={channel === c.value}
              onClick={() => setChannel(c.value)}
            >
              {c.label}
            </Button>
          ))}
        </div>

        {channel === "ebay" && (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              No links on eBay. eBay hides a listing that links off eBay. FlipDesk
              already adds this line with the cert number when you publish, set by the
              grade block in your FlipDesk description settings.
            </p>
            <div className="flex gap-2">
              <Input aria-label="eBay proof-of-grade line" readOnly value={EBAY_PROOF_LINE} className="text-sm" />
              <CopyButton value={EBAY_PROOF_LINE} label="eBay line" />
            </div>
          </div>
        )}

        {channel === "marketplace" && (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Poshmark, Depop and Mercari take plain text only. Paste this line and fill
              in the grade and cert number. Buyers can look the number up.
            </p>
            <div className="flex gap-2">
              <Textarea
                aria-label="Marketplace proof-of-grade line"
                readOnly
                rows={2}
                value={MARKETPLACE_PROOF_LINE}
                className="text-sm"
              />
              <CopyButton value={MARKETPLACE_PROOF_LINE} label="marketplace line" />
            </div>
          </div>
        )}

        {channel === "site" && (
          <div className="space-y-3">
            <div className="flex items-center justify-center rounded-md border bg-muted/40 p-4">
              {/* A preview, not a link: clicking your own badge would count as a click. */}
              <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-navy px-3 py-1.5 text-sm font-semibold text-white">
                <Check className="h-3.5 w-3.5" aria-hidden /> Graded by GradeThread
              </span>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="ref-embed-code" className="text-sm font-medium">
                Badge code (HTML) for your site or blog
              </label>
              <div className="flex gap-2">
                <Textarea id="ref-embed-code" readOnly value={badge} rows={4} className="font-mono text-xs" />
                <CopyButton value={badge} label="badge code" />
              </div>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="ref-badge-link" className="text-sm font-medium">
                Or just the link, for social posts
              </label>
              <div className="flex gap-2">
                <Input id="ref-badge-link" readOnly value={link} className="font-mono text-sm" />
                <CopyButton value={link} label="badge link" />
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FunnelStats() {
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["affiliate-me"],
    queryFn: async (): Promise<AffiliateMe> => {
      const res = await edgeFetch("/api/affiliate/me");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't load your link stats");
      return json;
    },
  });

  if (isError) {
    return (
      <ErrorState title="Couldn't load your link stats" onRetry={() => refetch()} retrying={isFetching} hideSupport />
    );
  }
  if (isLoading || !data) {
    return (
      <div className="grid grid-cols-3 gap-3" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }
  const rate = data.clicks.total > 0
    ? `${Math.round((data.clicks.converted / data.clicks.total) * 100)}%`
    : "No clicks yet";
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-3 text-center">
        {[
          { label: "Link clicks", value: data.clicks.total },
          { label: "Last 30 days", value: data.clicks.last30 },
          { label: "Signups", value: data.conversions },
        ].map((s) => (
          <div key={s.label} className="rounded-md bg-muted p-3">
            <div className="text-2xl font-bold tabular-nums">{s.value}</div>
            <div className="text-xs text-muted-foreground">{s.label}</div>
          </div>
        ))}
      </div>
      <p className="text-center text-xs text-muted-foreground">
        Clicks that turned into signups: {rate}
      </p>
    </div>
  );
}

function ChecklistStep({
  done,
  label,
  action,
}: {
  done: boolean;
  label: string;
  action?: ReactNode;
}) {
  return (
    <li className="flex items-center justify-between gap-3 py-2 text-sm">
      <span className="flex items-center gap-2">
        {done ? (
          <Check className="h-4 w-4 text-success-text" aria-hidden />
        ) : (
          <Circle className="h-4 w-4 text-muted-foreground" aria-hidden />
        )}
        <span className={done ? "" : "text-muted-foreground"}>
          {label}
          <span className="sr-only">{done ? " (done)" : " (to do)"}</span>
        </span>
      </span>
      {!done && action}
    </li>
  );
}

function PayoutCard({ onOpenCreator }: { onOpenCreator: () => void }) {
  const [connecting, setConnecting] = useState(false);
  const { data: payouts, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["affiliate-payouts"],
    queryFn: async (): Promise<AffiliatePayouts> => {
      const res = await edgeFetch("/api/affiliate/payouts");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't load your payouts");
      return json;
    },
  });

  if (isError) {
    return (
      <ErrorState title="Couldn't load your payouts" onRetry={() => refetch()} retrying={isFetching} />
    );
  }
  if (isLoading || !payouts) {
    return <Skeleton className="h-48 w-full" aria-busy="true" />;
  }

  if (!payouts.enabled) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-dashed p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
        <p className="text-muted-foreground">
          Badge signups earn grade credits. Cash is for approved creators.
        </p>
        <Button type="button" variant="outline" onClick={onOpenCreator}>
          About the creator program
        </Button>
      </div>
    );
  }

  const connect = async () => {
    setConnecting(true);
    try {
      await startPayoutOnboarding();
    } catch {
      setConnecting(false);
    }
  };

  const stripeReady = payouts.onboarding.payouts_enabled;
  const taxOnFile = payouts.tax_profile_certified === true;
  const inTransit = payouts.balance.in_transit ?? 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Wallet className="h-5 w-5 text-brand-red-text" /> Creator payouts
        </CardTitle>
        <CardDescription>
          {payoutRateCopy(payouts)} Balances pay out over Stripe once they clear{" "}
          {usd(payouts.minimum_payout)}, after a {payouts.hold_days}-day hold.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
          {[
            { label: "Ready to pay", value: payouts.balance.accrued_payable },
            { label: "On hold", value: payouts.balance.accrued_held },
            { label: "Sending", value: inTransit },
            { label: "Paid out", value: payouts.balance.paid },
          ].map((s) => (
            <div key={s.label} className="rounded-md bg-muted p-3">
              <div className="text-xl font-bold tabular-nums">{usd(s.value)}</div>
              <div className="text-xs text-muted-foreground">{s.label}</div>
            </div>
          ))}
        </div>

        <div>
          <p className="text-sm font-medium">Before we can pay you</p>
          <ol className="divide-y">
            <ChecklistStep done label="Approved as a creator" />
            <ChecklistStep
              done={stripeReady}
              label={payouts.onboarding.connected ? "Stripe setup finished" : "Stripe connected"}
              action={
                <Button size="sm" onClick={connect} disabled={connecting}>
                  {connecting ? "Opening..." : payouts.onboarding.connected ? "Finish setup" : "Set up payouts"}
                </Button>
              }
            />
            <ChecklistStep
              done={taxOnFile}
              label="Tax form on file"
              action={
                <Button size="sm" variant="outline" onClick={onOpenCreator}>
                  Add tax details
                </Button>
              }
            />
          </ol>
          {payouts.blocked_reason === "below_minimum" && (
            <p className="mt-1 text-xs text-muted-foreground">
              Your payable balance is under the {usd(payouts.minimum_payout)} minimum. It
              keeps adding up until it clears.
            </p>
          )}
        </div>

        <div>
          <p className="text-sm font-medium">Payout history</p>
          {payouts.payouts.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No payouts yet.</p>
          ) : (
            <ul className="divide-y">
              {payouts.payouts.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="text-muted-foreground">
                    {new Date(p.paid_at ?? p.created_at).toLocaleDateString()}
                  </span>
                  <span className="tabular-nums">{usd(p.amount)}</span>
                  <span
                    className={cn(
                      "text-xs",
                      p.status === "paid" ? "text-success-text" : p.status === "failed" ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {PAYOUT_STATUS[p.status] ?? p.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {payouts.payouts.some((p) => p.status === "failed") && (
            <p className="text-xs text-muted-foreground">
              A failed payout is retried automatically. If it keeps failing, check your
              Stripe account or email support.
            </p>
          )}
        </div>

        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            {usd(payouts.tax.paid_this_year)} of {usd(payouts.tax.threshold)} this year.
            {payouts.tax.reaches_1099_threshold
              ? " You're at or over the line, so we'll send you a 1099."
              : " At that line we send a 1099."}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

export function AffiliateTab({ code, onOpenCreator }: { code: string; onOpenCreator: () => void }) {
  return (
    <div className="space-y-6">
      <ProofOfGradeCard code={code} />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your link's numbers</CardTitle>
          <CardDescription>
            Signups through your link and badge earn the same grade credits as a referral.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FunnelStats />
        </CardContent>
      </Card>
      <PayoutCard onOpenCreator={onOpenCreator} />
    </div>
  );
}
