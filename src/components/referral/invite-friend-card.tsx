import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Gift, Copy, Check, Share2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { edgeFetch } from "@/lib/edge-fetch";
import { shareOrCopy } from "@/lib/share";
import { track } from "@/lib/analytics";

// US-862: dashboard amplification for the (already wired) referral program.
// Surfaces the user's existing /signup?ref=CODE link with copy + native share
// actions. Reuses GET /api/referrals/me — no new program logic.

interface ReferralMe {
  code: string;
  stats: { total: number; pending: number; qualified: number; granted: number };
  referred_by: { status: string; code: string } | null;
}

export function InviteFriendCard() {
  const [copied, setCopied] = useState(false);

  const { data } = useQuery({
    queryKey: ["referrals-me"],
    queryFn: async (): Promise<ReferralMe> => {
      const res = await edgeFetch("/api/referrals/me");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load referrals");
      return json;
    },
    staleTime: 5 * 60 * 1000,
  });

  // Don't render a half-baked card before the code resolves.
  if (!data?.code) return null;

  const shareLink = `${window.location.origin}/signup?ref=${data.code}`;
  const text =
    "I'm using GradeThread to get AI condition grades on my pre-owned clothing. Join with my link — we both earn grade credits.";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      track("referral_share", { method: "copy", surface: "dashboard" });
    } catch {
      /* clipboard blocked — the native share button is the fallback */
    }
  };

  const share = async () => {
    const result = await shareOrCopy({
      title: "GradeThread",
      text,
      url: shareLink,
      copiedMessage: "Invite link copied",
    });
    if (result === "shared" || result === "copied") {
      track("referral_share", {
        method: result === "shared" ? "web_share" : "copy",
        surface: "dashboard",
      });
    }
  };

  return (
    <Card className="border-brand-red/30 bg-brand-red/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Gift className="h-5 w-5 text-brand-red-text" /> Invite a friend
        </CardTitle>
        <CardDescription>
          Share your link. When a friend joins and qualifies, you both earn
          grade credits — added to your balance automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input readOnly value={shareLink} className="font-mono text-sm" />
          <Button onClick={copy} variant="outline" aria-label="Copy referral link">
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          </Button>
          <Button onClick={share}>
            <Share2 className="mr-1.5 h-4 w-4" />
            Share
          </Button>
        </div>
        {data.stats.granted > 0 && (
          <p className="text-xs text-muted-foreground">
            You've earned credits from {data.stats.granted}{" "}
            {data.stats.granted === 1 ? "referral" : "referrals"} so far.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
