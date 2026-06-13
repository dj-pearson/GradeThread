import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
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
import { Textarea } from "@/components/ui/textarea";
import { edgeFetch } from "@/lib/edge-fetch";
import { affiliateBadgeEmbed, affiliateLink } from "@/lib/affiliate";
import { Gift, Copy, Check, BadgeCheck } from "lucide-react";

interface ReferralMe {
  code: string;
  stats: { total: number; pending: number; qualified: number; granted: number };
  referred_by: { status: string; code: string } | null;
}

interface AffiliateMe {
  code: string;
  clicks: { total: number; last30: number; converted: number };
  conversions: number;
}

export function ReferralsPage() {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [copiedEmbed, setCopiedEmbed] = useState(false);
  const [copiedBadgeLink, setCopiedBadgeLink] = useState(false);
  const [redeemCode, setRedeemCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);

  const { data, isLoading } = useQuery({
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
    } finally {
      setRedeeming(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Gift className="h-6 w-6 text-brand-red-text" /> Refer a friend
        </h1>
        <p className="text-muted-foreground">
          Share your link. When a friend joins and qualifies, you both earn grade
          credits — added to your balance automatically, and we'll let you know.
        </p>
      </div>

      {isLoading || !data ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Your referral link</CardTitle>
              <CardDescription>Code: <span className="font-mono font-semibold">{data.code}</span></CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input readOnly value={shareLink} className="font-mono text-sm" />
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
                <label className="text-xs font-medium text-muted-foreground">Embed code (HTML)</label>
                <div className="flex gap-2">
                  <Textarea
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
                <label className="text-xs font-medium text-muted-foreground">Or just the link</label>
                <div className="flex gap-2">
                  <Input readOnly value={badgeLink} className="font-mono text-sm" />
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
        </>
      )}
    </div>
  );
}
