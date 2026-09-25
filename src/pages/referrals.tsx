import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { Progress } from "@/components/ui/progress";
import { edgeFetch } from "@/lib/edge-fetch";
import { referralLink, storedAffiliateClickId } from "@/lib/affiliate";
import { shareOrCopy } from "@/lib/share";
import {
  DEFAULT_REFERRAL_SECTION,
  isReferralSection,
  type ReferralSection,
} from "@/lib/settings-tabs";
import { TopReferrers } from "@/components/referral/top-referrers";
import { REFERRAL_LEADERBOARD_QUERY_KEY, referralShareMessage } from "@/lib/referral-page";
import { CreatorProgramme } from "@/components/referral/creator-programme";
import { AffiliateTab } from "@/components/referral/affiliate-tab";
import { startPayoutOnboarding } from "@/lib/referral-page";
import { CopyButton } from "@/components/referral/copy-button";
import { ReferralTimeline } from "@/components/referral/referral-timeline";
import { Gift, Check, Trophy, Target } from "lucide-react";

interface ReferralMilestone {
  threshold: number;
  bonus: number;
}

export interface ReferralMe {
  code: string;
  stats: {
    total: number;
    pending: number;
    qualified: number;
    granted: number;
    // Still able to pay, and never able to pay. Absent on an older edge.
    waiting?: number;
    forfeit?: number;
  };
  // US-864: reward shown in actual grade credits.
  credits: { per_referral: number; earned: number; pending: number };
  rules?: {
    per_referral: number;
    referred_bonus: number;
    referred_on_qualify: number;
    window_days: number;
    cap: number;
    cap_remaining: number | null;
  };
  // US-1071: tiered/milestone rewards.
  milestones: {
    tiers: ReferralMilestone[];
    earned_thresholds: number[];
    earned_bonus_credits: number;
    next: { threshold: number; bonus: number; remaining: number } | null;
  };
  leaderboard: {
    enabled: boolean;
    display_name: string | null;
    rank?: number | null;
    tied?: boolean;
  };
  referred_by: { status: string; code: string } | null;
  redeem_eligible?: boolean;
}

// What a redeem refusal means, in words a seller can act on.
const REDEEM_ERRORS: Record<string, string> = {
  invalid_code:
    "That referral code doesn't exist. Promo codes go on the Billing tab, not here.",
  self_referral: "That's your own code. Share it with a friend instead.",
  already_referred: "You've already used a referral code.",
  account_suspended: "This account can't use referral codes right now.",
  account_too_old: "Referral codes are for new accounts.",
  already_paid: "Referral codes are for accounts that haven't bought credits yet.",
  circular_referral: "You referred this person, so you can't use their code.",
};

// The referred_by status, said plainly.
const REFERRED_STATUS: Record<string, string> = {
  pending: "Your friend gets their reward when you make your first paid grade.",
  qualified: "You made a paid grade. The reward is on its way.",
  granted: "Done. You both got your reward.",
};

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function ReferralsPage() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [redeemCode, setRedeemCode] = useState("");
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [redeeming, setRedeeming] = useState(false);
  // US-864: leaderboard opt-in form.
  const [leaderboardName, setLeaderboardName] = useState("");
  const [savingLeaderboard, setSavingLeaderboard] = useState(false);

  // ?section= picks the inner tab, so email, Stripe's return and support can
  // land on the right one. Any ?connect= (Stripe's return) forces Affiliate.
  const rawSection = params.get("section");
  const connectParam = params.get("connect");
  const section: ReferralSection = connectParam
    ? "affiliate"
    : isReferralSection(rawSection)
      ? rawSection
      : DEFAULT_REFERRAL_SECTION;

  const setSection = (next: string) => {
    if (!isReferralSection(next)) return;
    const n = new URLSearchParams(params);
    n.set("section", next);
    setParams(n, { replace: true });
  };

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["referrals-me"],
    queryFn: async (): Promise<ReferralMe> => {
      const res = await edgeFetch("/api/referrals/me");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load referrals");
      return json;
    },
  });

  // Returning from Stripe Connect (?connect=done|refresh). Handled once per
  // arrival: the param is stripped straight away, so a reload does not call
  // Stripe again. 'refresh' means the onboarding link expired, so it opens a
  // fresh one; 'done' asks the edge to re-read the account and says the result.
  const handledConnect = useRef(false);
  useEffect(() => {
    if (!connectParam || handledConnect.current) return;
    handledConnect.current = true;
    const n = new URLSearchParams(params);
    n.delete("connect");
    n.set("section", "affiliate");
    setParams(n, { replace: true });

    if (connectParam === "refresh") {
      void startPayoutOnboarding().catch(() => {});
      return;
    }
    if (connectParam === "done") {
      edgeFetch("/api/affiliate/connect/status")
        .then((res) => res.json().catch(() => ({})))
        .then((json: { payouts_enabled?: boolean }) => {
          if (json.payouts_enabled) toast.success("Payouts are on.");
          else toast("Stripe still needs a few details.");
        })
        .catch(() => toast("Stripe still needs a few details."))
        .finally(() => {
          void qc.invalidateQueries({ queryKey: ["affiliate-payouts"] });
        });
    }
  }, [connectParam, params, setParams, qc]);

  const code = data?.code ?? "";
  const shareLink = code ? referralLink(code, "copy") : "";
  const shareMessage = referralShareMessage(data?.rules?.referred_bonus);

  const redeem = async (e: FormEvent) => {
    e.preventDefault();
    const typed = redeemCode.trim().toUpperCase();
    if (!typed) return;
    setRedeeming(true);
    setRedeemError(null);
    try {
      // A code this browser landed on through a link still names that click.
      const clickId = storedAffiliateClickId(typed);
      const res = await edgeFetch("/api/referrals/redeem", {
        method: "POST",
        json: clickId ? { code: typed, source: "affiliate", click_id: clickId } : { code: typed },
        silentGate: true,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRedeemError(REDEEM_ERRORS[json.error_code] ?? json.error ?? "Couldn't use that code.");
        return;
      }
      const credits = typeof json.credits === "number" ? json.credits : 0;
      toast.success(
        credits > 0 ? `You got ${plural(credits, "free grade")}.` : "Referral code applied.",
      );
      setRedeemCode("");
      void qc.invalidateQueries({ queryKey: ["referrals-me"] });
      void qc.invalidateQueries({ queryKey: ["billing_summary"] });
    } catch (err) {
      // US-1634: edgeFetch throws on a network error / expired session.
      toastError(err, "Couldn't use that code.");
    } finally {
      setRedeeming(false);
    }
  };

  const openShare = (url: string) => {
    if (typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
  };

  const share = async () => {
    if (!code) return;
    await shareOrCopy({
      title: "GradeThread",
      text: shareMessage,
      url: referralLink(code, "copy"),
      copiedMessage: "Link copied. Paste it anywhere.",
    });
  };

  const shareTargets = code
    ? [
        {
          label: "X",
          url: `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareMessage)}&url=${encodeURIComponent(referralLink(code, "x"))}`,
        },
        {
          label: "Facebook",
          url: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(referralLink(code, "facebook"))}`,
        },
        {
          label: "WhatsApp",
          url: `https://wa.me/?text=${encodeURIComponent(`${shareMessage} ${referralLink(code, "whatsapp")}`)}`,
        },
        {
          label: "Email",
          url: `mailto:?subject=${encodeURIComponent("Grade your clothes with GradeThread")}&body=${encodeURIComponent(`${shareMessage} ${referralLink(code, "email")}`)}`,
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
      toast.success(enabled ? "Saved." : "Removed from the leaderboard.");
      void qc.invalidateQueries({ queryKey: ["referrals-me"] });
      void qc.invalidateQueries({ queryKey: REFERRAL_LEADERBOARD_QUERY_KEY });
    } catch (err) {
      // US-1634: surface a thrown error instead of a silent unhandled rejection.
      toastError(err, "Couldn't update your leaderboard settings.");
    } finally {
      setSavingLeaderboard(false);
    }
  };

  if (isError) {
    return (
      <div className="mx-auto max-w-2xl">
        <ErrorState
          title="Couldn't load your referrals"
          onRetry={() => refetch()}
          retrying={isFetching}
        />
      </div>
    );
  }
  if (isLoading || !data) {
    return (
      <div className="mx-auto max-w-2xl space-y-6" aria-busy="true">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    );
  }

  const rules = data.rules;
  const waiting = data.stats.waiting ?? data.stats.pending + data.stats.qualified;
  const forfeit = data.stats.forfeit ?? 0;
  const showRedeem = !data.referred_by && data.redeem_eligible !== false;
  const nameChanged = leaderboardName.trim() !== savedLeaderboardName;
  const rank = data.leaderboard.rank ?? null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* US-2543 AC2: sharing is what this page is for, so it opens on it; the
          affiliate program is a different job with its own payout setup, and
          the boards are opt-in. Each tab is its own URL (?section=). */}
      <Tabs value={section} onValueChange={setSection} className="space-y-6">
        <TabsList className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="share">Share</TabsTrigger>
          <TabsTrigger value="affiliate">Affiliate</TabsTrigger>
          {/* US-9212: cash, and a different arrangement from the credits the
              two tabs beside it earn. Its own tab so nobody agrees to a tax
              form while looking for a share link. */}
          <TabsTrigger value="creator">Creator</TabsTrigger>
          <TabsTrigger value="leaderboard">Leaderboard</TabsTrigger>
        </TabsList>

        <TabsContent value="share" className="space-y-6">
          {/* How the deal works, in the live numbers. */}
          {rules && (
            <ol className="grid gap-3 sm:grid-cols-3">
              {[
                { n: 1, text: "Share your link." },
                {
                  n: 2,
                  text:
                    rules.referred_bonus > 0
                      ? `Your friend gets ${plural(rules.referred_bonus, "free grade")} when they join.`
                      : "Your friend joins with your link.",
                },
                {
                  n: 3,
                  text: `You get ${plural(rules.per_referral, "credit")} after their first paid grade.`,
                },
              ].map((step) => (
                <li key={step.n} className="flex gap-3 rounded-md bg-muted p-3 text-sm">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-navy text-xs font-bold text-white">
                    {step.n}
                  </span>
                  <span>{step.text}</span>
                </li>
              ))}
            </ol>
          )}
          {rules && (rules.window_days > 0 || rules.cap > 0) && (
            <p className="text-xs text-muted-foreground">
              {rules.window_days > 0 &&
                `Your friend has ${rules.window_days} days to make that first paid grade. `}
              {rules.cap > 0 &&
                `You can earn from up to ${plural(rules.cap, "referral")}${
                  rules.cap_remaining != null ? ` (${rules.cap_remaining} left)` : ""
                }.`}
            </p>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Gift className="h-5 w-5 text-brand-red-text" /> Your referral link
              </CardTitle>
              <CardDescription>
                Code: <span className="font-mono font-semibold">{data.code}</span>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input aria-label="Your referral link" readOnly value={shareLink} className="font-mono text-sm" />
                <CopyButton value={shareLink} label="referral link" />
              </div>

              <div className="space-y-2">
                <Button onClick={share} className="w-full">
                  <Gift className="mr-2 h-4 w-4" /> Share your link
                </Button>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {shareTargets.map((t) => (
                    <Button key={t.label} variant="outline" size="sm" onClick={() => openShare(t.url)}>
                      {t.label}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="rounded-md bg-muted p-3">
                  <div className="text-2xl font-bold tabular-nums">{data.stats.total}</div>
                  <div className="text-xs text-muted-foreground">Referred</div>
                </div>
                <div className="rounded-md bg-muted p-3">
                  <div className="text-2xl font-bold tabular-nums">{waiting}</div>
                  <div className="text-xs text-muted-foreground">Waiting</div>
                </div>
                <div className="rounded-md bg-muted p-3">
                  <div className="text-2xl font-bold tabular-nums">{data.stats.granted}</div>
                  <div className="text-xs text-muted-foreground">Rewarded</div>
                </div>
              </div>
              {forfeit > 0 && (
                <p className="text-center text-xs text-muted-foreground">
                  {plural(forfeit, "referral")} didn't qualify. The list below says why.
                </p>
              )}

              {/* Credits as work: what the balance buys, not just a number. */}
              <div className="flex flex-col gap-3 rounded-md bg-muted p-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm">
                    <span className="text-2xl font-bold tabular-nums text-brand-red-text">
                      {data.credits.earned}
                    </span>{" "}
                    credits earned = {plural(data.credits.earned, "more garment")} graded
                  </p>
                  {data.credits.pending > 0 && (
                    <p className="text-xs text-muted-foreground">
                      {data.credits.pending} more on the way from referrals still waiting.
                    </p>
                  )}
                </div>
                {data.credits.earned > 0 && (
                  <Button asChild variant="outline" size="sm">
                    <Link to="/dashboard/submissions/new">Grade now</Link>
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Your referrals</CardTitle>
              <CardDescription>Who is waiting, who paid, and who didn't qualify.</CardDescription>
            </CardHeader>
            <CardContent>
              <ReferralTimeline />
            </CardContent>
          </Card>

          {/* US-1071: milestone / tiered rewards. */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Target className="h-5 w-5 text-brand-red-text" /> Milestone bonuses
              </CardTitle>
              <CardDescription>
                {data.milestones.next
                  ? `${plural(data.milestones.next.remaining, "more rewarded referral")} to unlock +${data.milestones.next.bonus} bonus credits.`
                  : "You've earned every milestone bonus. Nice work."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {data.milestones.next && (
                <Progress
                  aria-label="Progress to the next milestone"
                  aria-valuetext={`${data.stats.granted} of ${data.milestones.next.threshold} rewarded referrals`}
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
                      {earned && <Check className="h-3.5 w-3.5" aria-hidden />}
                      {tier.threshold} referrals: +{tier.bonus}
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
              <CardContent className="flex items-start gap-2 p-4 text-sm text-muted-foreground">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-success-text" aria-hidden />
                <span>
                  You joined with code{" "}
                  <span className="font-mono font-semibold">{data.referred_by.code}</span>.{" "}
                  {REFERRED_STATUS[data.referred_by.status] ?? "Your reward is being processed."}
                </span>
              </CardContent>
            </Card>
          ) : showRedeem ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Were you referred?</CardTitle>
                <CardDescription>Enter a friend's code to claim your bonus.</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={redeem} className="space-y-2">
                  <div className="flex gap-2">
                    <Input
                      aria-label="Referral code from a friend"
                      aria-invalid={redeemError ? true : undefined}
                      aria-describedby={redeemError ? "redeem-error" : undefined}
                      value={redeemCode}
                      onChange={(e) => {
                        setRedeemCode(e.target.value.toUpperCase());
                        setRedeemError(null);
                      }}
                      placeholder="e.g. ABCD2345"
                      maxLength={8}
                      autoCapitalize="characters"
                      spellCheck={false}
                      autoComplete="off"
                      className="font-mono"
                    />
                    <Button type="submit" disabled={!redeemCode.trim() || redeeming}>
                      {redeeming ? "Applying..." : "Apply"}
                    </Button>
                  </div>
                  {redeemError && (
                    <p id="redeem-error" className="text-sm text-destructive">
                      {redeemError}{" "}
                      {redeemError === REDEEM_ERRORS.invalid_code && (
                        <Link to="/dashboard/account?tab=billing" className="underline">
                          Go to Billing
                        </Link>
                      )}
                    </p>
                  )}
                </form>
              </CardContent>
            </Card>
          ) : null}
        </TabsContent>

        <TabsContent value="affiliate" className="space-y-6">
          <AffiliateTab code={data.code} onOpenCreator={() => setSection("creator")} />
        </TabsContent>

        <TabsContent value="creator" className="space-y-6">
          <CreatorProgramme onOpenAffiliate={() => setSection("affiliate")} />
        </TabsContent>

        <TabsContent value="leaderboard" className="space-y-6">
          {/* US-864: opt into the public top-referrers leaderboard. */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Trophy className="h-5 w-5 text-brand-red-text" /> Top referrers leaderboard
              </CardTitle>
              <CardDescription>
                Opt in to appear on the public{" "}
                <Link to="/leaderboard" className="font-medium underline">
                  leaderboard
                </Link>
                . Only the display name you choose is shown, never your email.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveLeaderboard(true);
                }}
              >
                <div className="space-y-1.5">
                  <label htmlFor="ref-display-name" className="text-sm font-medium">
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
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm text-muted-foreground">
                    {!data.leaderboard.enabled
                      ? "You're not on the leaderboard."
                      : rank != null
                        ? data.leaderboard.tied
                          ? `You're tied for #${rank}.`
                          : `You're #${rank}.`
                        : "You'll appear once your first referral is rewarded."}
                  </p>
                  {data.leaderboard.enabled ? (
                    <div className="flex gap-2">
                      <Button type="submit" variant="outline" disabled={savingLeaderboard || !nameChanged}>
                        {savingLeaderboard ? "Saving..." : "Save name"}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={savingLeaderboard}
                        onClick={() => saveLeaderboard(false)}
                      >
                        Hide me
                      </Button>
                    </div>
                  ) : (
                    <Button type="submit" disabled={savingLeaderboard || !leaderboardName.trim()}>
                      {savingLeaderboard ? "Saving..." : "Join leaderboard"}
                    </Button>
                  )}
                </div>
              </form>
            </CardContent>
          </Card>
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
    </div>
  );
}
