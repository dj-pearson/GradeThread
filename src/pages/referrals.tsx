import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { edgeFetch } from "@/lib/edge-fetch";
import { affiliateBadgeEmbed, affiliateLink } from "@/lib/affiliate";
import { TopReferrers } from "@/components/referral/top-referrers";
import { Gift, Copy, Check, BadgeCheck, Trophy, Target, Wallet, AlertCircle } from "lucide-react";

interface ReferralMilestone {
  threshold: number;
  bonus: number;
}

interface ReferralMe {
  code: string;
  stats: { total: number; pending: number; qualified: number; granted: number };
  // US-864: reward shown in actual grade credits.
  credits: { per_referral: number; earned: number; pending: number };
  // US-1071: tiered/milestone rewards.
  milestones: {
    tiers: ReferralMilestone[];
    earned_thresholds: number[];
    earned_bonus_credits: number;
    next: { threshold: number; bonus: number; remaining: number } | null;
  };
  leaderboard: { enabled: boolean; display_name: string | null };
  referred_by: { status: string; code: string } | null;
}

interface AffiliateMe {
  code: string;
  clicks: { total: number; last30: number; converted: number };
  conversions: number;
}

// US-1295: affiliate commission earnings + Stripe Connect payout status.
interface AffiliatePayouts {
  enabled: boolean;
  rate: number;
  minimum_payout: number;
  hold_days: number;
  onboarding: { connected: boolean; payouts_enabled: boolean };
  balance: { accrued_payable: number; accrued_held: number; paid: number };
  tax: { threshold: number; paid_this_year: number; reaches_1099_threshold: boolean };
  payouts: Array<{
    id: string;
    amount: number;
    status: string;
    stripe_transfer_id: string | null;
    paid_at: string | null;
    created_at: string;
  }>;
}

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

export function ReferralsPage() {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [copiedEmbed, setCopiedEmbed] = useState(false);
  const [copiedBadgeLink, setCopiedBadgeLink] = useState(false);
  const [redeemCode, setRedeemCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  // US-864: leaderboard opt-in form.
  const [leaderboardName, setLeaderboardName] = useState("");
  const [savingLeaderboard, setSavingLeaderboard] = useState(false);

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["referrals-me"],
    queryFn: async (): Promise<ReferralMe> => {
      const res = await edgeFetch("/api/referrals/me");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load referrals");
      return json;
    },
  });

  const { data: affiliate } = useQuery({
    queryKey: ["affiliate-me"],
    queryFn: async (): Promise<AffiliateMe> => {
      const res = await edgeFetch("/api/affiliate/me");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load affiliate stats");
      return json;
    },
  });

  // US-1295: affiliate payout earnings + Stripe Connect onboarding state.
  const { data: payouts, refetch: refetchPayouts } = useQuery({
    queryKey: ["affiliate-payouts"],
    queryFn: async (): Promise<AffiliatePayouts> => {
      const res = await edgeFetch("/api/affiliate/payouts");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load affiliate payouts");
      return json;
    },
  });
  const [connecting, setConnecting] = useState(false);

  // Returning from Stripe onboarding (?connect=done) — refresh status once.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("connect") === "done") {
      edgeFetch("/api/affiliate/connect/status")
        .catch(() => {})
        .finally(() => refetchPayouts());
    }
  }, [refetchPayouts]);

  const startPayoutOnboarding = async () => {
    setConnecting(true);
    try {
      const res = await edgeFetch("/api/affiliate/connect", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.url) throw new Error(json.error || "Couldn't start onboarding");
      window.location.href = json.url;
    } catch (e) {
      toastError(e, "Couldn't start payout onboarding.");
      setConnecting(false);
    }
  };

  const shareLink = data ? `${window.location.origin}/signup?ref=${data.code}` : "";

  const copy = async () => {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Couldn't copy — copy it manually.");
    }
  };

  const badgeEmbed = data ? affiliateBadgeEmbed(data.code) : "";
  const badgeLink = data ? affiliateLink(data.code, "badge") : "";

  const copyTo = async (text: string, set: (v: boolean) => void) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      set(true);
      setTimeout(() => set(false), 1800);
    } catch {
      toast.error("Couldn't copy — copy it manually.");
    }
  };

  const redeem = async () => {
    const code = redeemCode.trim().toUpperCase();
    if (!code) return;
    setRedeeming(true);
    try {
      const res = await edgeFetch("/api/referrals/redeem", {
        method: "POST",
        json: { code },
        silentGate: true,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? "Couldn't redeem that code.");
        return;
      }
      toast.success("Referral code applied!");
      setRedeemCode("");
      qc.invalidateQueries({ queryKey: ["referrals-me"] });
    } catch (err) {
      // US-1634: edgeFetch throws on a network error / expired session — without
      // a catch this was a silent unhandled rejection (the button just stopped
      // spinning with no feedback).
      toastError(err, "Couldn't redeem that code.");
    } finally {
      setRedeeming(false);
    }
  };

  // US-1071: prefilled social share. The link carries the affiliate ?ref= so
  // shares through these channels are attributed + counted like the badge.
  const sharePromo = data ? affiliateLink(data.code, "link") : "";
  const shareMessage =
    "I grade my pre-owned clothing with GradeThread — get a free condition grade + certificate. Join with my link:";

  const openShare = (url: string) => {
    if (typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
  };

  const shareNative = async () => {
    if (!sharePromo) return;
    // Web Share API where available (mobile), else copy the message + link.
    const nav = navigator as Navigator & { share?: (d: { title?: string; text?: string; url?: string }) => Promise<void> };
    if (typeof nav.share === "function") {
      try {
        await nav.share({ title: "GradeThread", text: shareMessage, url: sharePromo });
        return;
      } catch {
        /* user dismissed — fall through to copy */
      }
    }
    await copyTo(`${shareMessage} ${sharePromo}`, () => {});
    toast.success("Share message copied — paste it anywhere.");
  };

  const shareTargets = sharePromo
    ? [
        {
          label: "X",
          url: `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareMessage)}&url=${encodeURIComponent(sharePromo)}`,
        },
        {
          label: "Facebook",
          url: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(sharePromo)}`,
        },
        {
          label: "WhatsApp",
          url: `https://wa.me/?text=${encodeURIComponent(`${shareMessage} ${sharePromo}`)}`,
        },
        {
          label: "Email",
          url: `mailto:?subject=${encodeURIComponent("Grade your clothes with GradeThread")}&body=${encodeURIComponent(`${shareMessage} ${sharePromo}`)}`,
        },
      ]
    : [];

  // Seed the leaderboard-alias input from the saved value once it loads.
  const savedLeaderboardName = data?.leaderboard.display_name ?? "";
  useEffect(() => {
    setLeaderboardName(savedLeaderboardName);
  }, [savedLeaderboardName]);

  // US-864: save the leaderboard opt-in + public alias. `enabled` toggles
  // visibility; the alias is the only identity shown publicly.
  const saveLeaderboard = async (enabled: boolean) => {
    const name = leaderboardName.trim();
    if (enabled && !name) {
      toast.error("Add a display name before joining the leaderboard.");
      return;
    }
    setSavingLeaderboard(true);
    try {
      const res = await edgeFetch("/api/referrals/leaderboard", {
        method: "PUT",
        json: { enabled, display_name: name || null },
        silentGate: true,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? "Couldn't update your leaderboard settings.");
        return;
      }
      toast.success(enabled ? "You're on the leaderboard!" : "Removed from the leaderboard.");
      qc.invalidateQueries({ queryKey: ["referrals-me"] });
    } catch (err) {
      // US-1634: surface a thrown error instead of a silent unhandled rejection.
      toastError(err, "Couldn't update your leaderboard settings.");
    } finally {
      setSavingLeaderboard(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader
        icon={Gift}
        title="Refer a friend"
        subtitle="Share your link. When a friend joins and qualifies, you both earn grade credits — added to your balance automatically, and we'll let you know."
      />

      {isError ? (
        <ErrorState
          title="Couldn't load your referrals"
          onRetry={() => refetch()}
          retrying={isFetching}
        />
      ) : isLoading || !data ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          {/* US-2543 AC2: eight stacked cards, three of which were code
              boxes that looked alike. Sharing is what this page is for, so
              it opens on it; the affiliate program is a different job with
              its own payout setup, and the boards are opt-in. */}
          <Tabs defaultValue="share" className="space-y-6">
            <TabsList>
              <TabsTrigger value="share">Share</TabsTrigger>
              <TabsTrigger value="affiliate">Affiliate</TabsTrigger>
              <TabsTrigger value="boards">Leaderboard</TabsTrigger>
            </TabsList>

            <TabsContent value="share" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Your referral link</CardTitle>
                <CardDescription>Code: <span className="font-mono font-semibold">{data.code}</span></CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-2">
                  {/* Read-only, but still a control someone can focus and copy
                      from — and the CardTitle above it names the CARD, not this
                      field. */}
                  <Input aria-label="Your referral link" readOnly value={shareLink} className="font-mono text-sm" />
                  <Button onClick={copy} variant="outline">
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <div className="grid grid-cols-3 gap-3 text-center">
                  <div className="rounded-md bg-muted p-3">
                    <div className="text-2xl font-bold tabular-nums">{data.stats.total}</div>
                    <div className="text-xs text-muted-foreground">Referred</div>
                  </div>
                  <div className="rounded-md bg-muted p-3">
                    <div className="text-2xl font-bold tabular-nums">{data.stats.pending + data.stats.qualified}</div>
                    <div className="text-xs text-muted-foreground">In progress</div>
                  </div>
                  <div className="rounded-md bg-muted p-3">
                    <div className="text-2xl font-bold tabular-nums">{data.stats.granted}</div>
                    <div className="text-xs text-muted-foreground">Rewarded</div>
                  </div>
                </div>

                {/* US-864: rewards in actual grade credits — earned (already on
                    your balance) vs. pending (still-qualifying referrals). */}
                <div className="grid grid-cols-2 gap-3 text-center">
                  <div className="rounded-md border border-brand-red/30 bg-brand-red/5 p-3">
                    <div className="text-2xl font-bold tabular-nums text-brand-red-text">
                      {data.credits.earned}
                    </div>
                    <div className="text-xs text-muted-foreground">Credits earned</div>
                  </div>
                  <div className="rounded-md bg-muted p-3">
                    <div className="text-2xl font-bold tabular-nums">{data.credits.pending}</div>
                    <div className="text-xs text-muted-foreground">Credits pending</div>
                  </div>
                </div>
                <p className="text-center text-xs text-muted-foreground">
                  You earn {data.credits.per_referral} grade credits each time a
                  referral qualifies — applied to your balance automatically.
                </p>

                {/* US-1071: prefilled one-tap share. */}
                <div className="space-y-2">
                  <Button onClick={shareNative} className="w-full">
                    <Gift className="mr-2 h-4 w-4" /> Share your link
                  </Button>
                  <div className="grid grid-cols-4 gap-2">
                    {shareTargets.map((t) => (
                      <Button
                        key={t.label}
                        variant="outline"
                        size="sm"
                        onClick={() => openShare(t.url)}
                      >
                        {t.label}
                      </Button>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
            {/* US-1071: milestone / tiered rewards — bonus credits for hitting
                referral thresholds. */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Target className="h-5 w-5 text-brand-red-text" /> Milestone bonuses
                </CardTitle>
                <CardDescription>
                  {data.milestones.next
                    ? `${data.milestones.next.remaining} more referral${
                        data.milestones.next.remaining === 1 ? "" : "s"
                      } to unlock +${data.milestones.next.bonus} bonus credits.`
                    : "You've earned every milestone bonus — nice work!"}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {data.milestones.next && (
                  <Progress
                    value={Math.min(
                      100,
                      Math.round((data.stats.granted / data.milestones.next.threshold) * 100),
                    )}
                  />
                )}
                <div className="flex flex-wrap gap-2">
                  {data.milestones.tiers.map((tier) => {
                    const earned = data.milestones.earned_thresholds.includes(tier.threshold);
                    return (
                      <div
                        key={tier.threshold}
                        className={
                          "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium " +
                          (earned
                            ? "border-brand-red/40 bg-brand-red/5 text-brand-red-text"
                            : "text-muted-foreground")
                        }
                      >
                        {earned && <Check className="h-3.5 w-3.5" />}
                        {tier.threshold} referrals → +{tier.bonus}
                      </div>
                    );
                  })}
                </div>
                {data.milestones.earned_bonus_credits > 0 && (
                  <p className="text-xs text-muted-foreground">
                    You've earned {data.milestones.earned_bonus_credits} bonus credits from milestones.
                  </p>
                )}
              </CardContent>
            </Card>
            {data.referred_by ? (
              <Card>
                <CardContent className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                  <Check className="h-4 w-4 text-green-600 dark:text-green-400" />
                  You were referred with code{" "}
                  <span className="font-mono font-semibold">{data.referred_by.code}</span> — reward status:{" "}
                  {data.referred_by.status}.
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Were you referred?</CardTitle>
                  <CardDescription>Enter a friend's code to claim your bonus.</CardDescription>
                </CardHeader>
                <CardContent className="flex gap-2">
                  <Input
                    aria-label="Referral code from a friend"
                    value={redeemCode}
                    onChange={(e) => setRedeemCode(e.target.value.toUpperCase())}
                    placeholder="e.g. ABCD2345"
                    className="font-mono"
                  />
                  <Button onClick={redeem} disabled={!redeemCode.trim() || redeeming}>
                    {redeeming ? "Applying…" : "Apply"}
                  </Button>
                </CardContent>
              </Card>
            )}
            </TabsContent>

            <TabsContent value="affiliate" className="space-y-6">
            {/* US-603: affiliate / earned-link channel. Embed the badge anywhere a
                shopper will see it (eBay listing, your site) — clicks that turn
                into qualified signups earn the same grade credits as a referral. */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <BadgeCheck className="h-5 w-5 text-brand-red-text" /> Earned-link badge
                </CardTitle>
                <CardDescription>
                  Add a “Graded by GradeThread” badge to your listings or site. It
                  carries your referral code, so shoppers who join through it count
                  toward your rewards.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-center rounded-md border bg-muted/40 p-4">
                  <a
                    href={badgeLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-full bg-brand-navy px-3 py-1.5 text-[13px] font-semibold text-white no-underline"
                  >
                    <Check className="h-3.5 w-3.5" /> Graded by GradeThread
                  </a>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="ref-embed-code" className="text-xs font-medium text-muted-foreground">Embed code (HTML)</label>
                  <div className="flex gap-2">
                    <Textarea
                      id="ref-embed-code"
                      readOnly
                      value={badgeEmbed}
                      rows={3}
                      className="font-mono text-xs"
                    />
                    <Button
                      variant="outline"
                      onClick={() => copyTo(badgeEmbed, setCopiedEmbed)}
                    >
                      {copiedEmbed ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="ref-badge-link" className="text-xs font-medium text-muted-foreground">Or just the link</label>
                  <div className="flex gap-2">
                    <Input id="ref-badge-link" readOnly value={badgeLink} className="font-mono text-sm" />
                    <Button
                      variant="outline"
                      onClick={() => copyTo(badgeLink, setCopiedBadgeLink)}
                    >
                      {copiedBadgeLink ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    </Button>
                  </div>
                </div>

                {affiliate && (
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div className="rounded-md bg-muted p-3">
                      <div className="text-2xl font-bold tabular-nums">{affiliate.clicks.total}</div>
                      <div className="text-xs text-muted-foreground">Link clicks</div>
                    </div>
                    <div className="rounded-md bg-muted p-3">
                      <div className="text-2xl font-bold tabular-nums">{affiliate.clicks.last30}</div>
                      <div className="text-xs text-muted-foreground">Last 30 days</div>
                    </div>
                    <div className="rounded-md bg-muted p-3">
                      <div className="text-2xl font-bold tabular-nums">{affiliate.conversions}</div>
                      <div className="text-xs text-muted-foreground">Signups</div>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
            {/* US-1295: affiliate commission payouts (Stripe Connect). Only shown
                when the program is enabled — otherwise affiliate conversions earn
                grade credits only. */}
            {payouts?.enabled && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Wallet className="h-5 w-5 text-brand-red-text" /> Affiliate payouts
                  </CardTitle>
                  <CardDescription>
                    Earn {usd(payouts.rate)} for every shopper who joins through your
                    earned link and qualifies. Balances pay out automatically over
                    Stripe once they clear {usd(payouts.minimum_payout)} (after a{" "}
                    {payouts.hold_days}-day hold).
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div className="rounded-md bg-muted p-3">
                      <div className="text-2xl font-bold tabular-nums">
                        {usd(payouts.balance.accrued_payable)}
                      </div>
                      <div className="text-xs text-muted-foreground">Ready to pay</div>
                    </div>
                    <div className="rounded-md bg-muted p-3">
                      <div className="text-2xl font-bold tabular-nums">
                        {usd(payouts.balance.accrued_held)}
                      </div>
                      <div className="text-xs text-muted-foreground">On hold</div>
                    </div>
                    <div className="rounded-md bg-muted p-3">
                      <div className="text-2xl font-bold tabular-nums">
                        {usd(payouts.balance.paid)}
                      </div>
                      <div className="text-xs text-muted-foreground">Paid out</div>
                    </div>
                  </div>

                  {payouts.onboarding.payouts_enabled ? (
                    <p className="text-sm text-muted-foreground">
                      Your Stripe payout account is connected and active.
                    </p>
                  ) : (
                    <div className="flex flex-col gap-2 rounded-md border border-dashed p-3 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-sm text-muted-foreground">
                        {payouts.onboarding.connected
                          ? "Finish setting up your Stripe payout account to receive transfers."
                          : "Connect a Stripe account to get paid your affiliate commissions."}
                      </p>
                      <Button onClick={startPayoutOnboarding} disabled={connecting}>
                        {connecting
                          ? "Opening…"
                          : payouts.onboarding.connected
                            ? "Finish setup"
                            : "Set up payouts"}
                      </Button>
                    </div>
                  )}

                  {payouts.tax.reaches_1099_threshold && (
                    <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>
                        You've been paid {usd(payouts.tax.paid_this_year)} this year —
                        at or above the {usd(payouts.tax.threshold)} threshold, so a
                        1099 tax form may be issued.
                      </span>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
            </TabsContent>

            <TabsContent value="boards" className="space-y-6">
            {/* US-864: opt into the public top-referrers leaderboard. */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Trophy className="h-5 w-5 text-brand-red-text" /> Top referrers leaderboard
                </CardTitle>
                <CardDescription>
                  Opt in to appear on the public{" "}
                  <a href="/leaderboard" className="font-medium underline">
                    leaderboard
                  </a>
                  . Only the display name you choose is shown — never your email.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5">
                  <label htmlFor="ref-display-name" className="text-xs font-medium text-muted-foreground">
                    Public display name
                  </label>
                  <Input
                    id="ref-display-name"
                    value={leaderboardName}
                    onChange={(e) => setLeaderboardName(e.target.value.slice(0, 40))}
                    placeholder="e.g. ThriftKing"
                    maxLength={40}
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm text-muted-foreground">
                    {data.leaderboard.enabled
                      ? "You're visible on the leaderboard."
                      : "You're not on the leaderboard yet."}
                  </p>
                  {data.leaderboard.enabled ? (
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        disabled={savingLeaderboard}
                        onClick={() => saveLeaderboard(true)}
                      >
                        Save name
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={savingLeaderboard}
                        onClick={() => saveLeaderboard(false)}
                      >
                        Hide me
                      </Button>
                    </div>
                  ) : (
                    <Button
                      disabled={savingLeaderboard || !leaderboardName.trim()}
                      onClick={() => saveLeaderboard(true)}
                    >
                      {savingLeaderboard ? "Saving…" : "Join leaderboard"}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
            {/* Live top-referrers preview (public feed). */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Leaderboard</CardTitle>
                <CardDescription>The current top referrers.</CardDescription>
              </CardHeader>
              <CardContent>
                <TopReferrers limit={5} />
              </CardContent>
            </Card>
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
