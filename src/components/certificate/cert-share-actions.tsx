import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Printer, Share2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { track } from "@/lib/analytics";
import { SITE_URL } from "@/lib/seo/site";
import { useAuthStore } from "@/stores/auth-store";
import { edgeFetch } from "@/lib/edge-fetch";
import { prefersNativeShare } from "@/lib/share";

// US-767 (implements US-607): turn the certificate into a first-class
// shareable. Native share sheet (with the slab image where supported) + a
// copy-link fallback, and a print / "Save as PDF" action. The shared link
// unfurls via the cert OG image (US-307).
//
// US-1288: close the viral loop — when the sharer is signed in, bake their
// existing referral code into every shared link so sharing a grade also grows
// the platform. We reuse the already-wired referral provisioning
// (GET /api/referrals/me) and the affiliate ?ref= attribution captured app-wide
// by captureAffiliateRef() (a ?ref= + utm_source=certificate on the cert URL is
// stored last-touch and redeemed when the visitor signs up). One-tap channels
// (X, Facebook, Pinterest, WhatsApp, Reddit, Email) unfurl the slab OG image.
//
// US-1854: close the earn half. Every share press is reported as a TRACKED
// SHARE — which pays nothing on its own, deliberately. The reward lands later,
// on verified click-throughs of the shared link, somewhere the sharer does not
// control; a button that paid on press would be a button to mash. The panel
// shows the owner what their find has actually earned so the loop is visible.

interface ReferralMe {
  code: string;
}

interface ShareLoopStats {
  shares: number;
  verified_clicks: number;
  milestones_earned: string[];
  next_milestone: { key: string; clicks: number; xp: number; label: string } | null;
}

export function CertShareActions({
  certificateId,
  title,
  score,
  tier,
}: {
  certificateId: string;
  title: string;
  score: number;
  tier: string;
}) {
  const [sharing, setSharing] = useState(false);
  const user = useAuthStore((s) => s.user);

  // Only signed-in viewers (the seller sharing their own grade) have a referral
  // code to bake in. Anonymous buyers viewing the cert share without one — the
  // share still works, it just doesn't carry attribution. Cached under the same
  // key as the dashboard invite card so it resolves instantly there.
  const { data: referral } = useQuery({
    queryKey: ["referrals-me"],
    queryFn: async (): Promise<ReferralMe> => {
      const res = await edgeFetch("/api/referrals/me");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load referrals");
      return json;
    },
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
  });
  const referralCode = referral?.code ?? null;

  const queryClient = useQueryClient();

  // What this find has earned from being shared. Owner-scoped SERVER-SIDE: a
  // signed-in viewer who doesn't own the certificate gets zeros, so the panel
  // below never needs to know who the owner is — it just doesn't render.
  const shareStatsKey = ["cert-share-loop", certificateId] as const;
  const { data: shareStats } = useQuery({
    queryKey: shareStatsKey,
    queryFn: async (): Promise<ShareLoopStats> => {
      const res = await edgeFetch(
        `/api/rewards/share/cert/${encodeURIComponent(certificateId)}`,
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load share stats");
      return json as ShareLoopStats;
    },
    enabled: !!user,
    staleTime: 60 * 1000,
    retry: false,
  });

  /**
   * Report the share. Fire-and-forget on purpose: this grants nothing, so a
   * failed ping costs the sharer no reward — and blocking the share sheet on a
   * request to us would be a worse trade than losing one row.
   */
  function reportShare(channel: string) {
    if (!user) return;
    void edgeFetch("/api/rewards/share", {
      method: "POST",
      json: { targetType: "cert", targetId: certificateId, channel },
      silentGate: true,
    })
      .then(() => queryClient.invalidateQueries({ queryKey: shareStatsKey }))
      .catch(() => {});
  }

  const origin =
    typeof window !== "undefined" ? window.location.origin : SITE_URL;

  // ?s=share lets a shared-link view be attributed (US-769) without any PII.
  //
  // US-2108 AC1: the referral code and the CHANNEL attribution are now separate
  // concerns, because they were previously coupled and that coupling is what
  // made buyer-to-buyer re-shares invisible.
  //
  //   ref=          — only when the viewer HAS a code, i.e. is the seller
  //                   sharing their own grade. Correct to omit for an anonymous
  //                   re-sharer: there is no one to credit, and borrowing the
  //                   code the visitor happened to arrive with would credit a
  //                   seller for a stranger's share. That is a product decision
  //                   about who earns, not an attribution gap to plug.
  //   utm_*         — ALWAYS. A re-share by an anonymous buyer is the highest-
  //                   reach share in the loop and was landing as direct traffic,
  //                   so the whole flywheel read as unattributable. Channel
  //                   attribution asserts nothing about who earns a credit.
  //
  // utm_medium distinguishes the two so a report can separate seller-driven
  // shares from organic re-shares rather than lumping them into one number.
  const refPart = referralCode
    ? `&ref=${encodeURIComponent(referralCode)}`
    : "";
  const campaign = referralCode ? "cert_referral" : "cert_organic";
  const attribution =
    `${refPart}&utm_source=certificate&utm_medium=share&utm_campaign=${campaign}`;
  const url = `${origin}/cert/${certificateId}?s=share${attribution}`;

  /**
   * Per-channel variant. utm_content is the only thing that differs, so a share
   * that actually converts can be traced to the network it came from — without
   * it, six buttons collapse into one undifferentiated "share" bucket.
   */
  const channelUrl = (channel: string) =>
    `${url}&utm_content=${encodeURIComponent(channel)}`;
  const slabImage = `${origin}/slab/cert/${encodeURIComponent(certificateId)}?format=square`;

  const baseText = `${title} — verified condition grade ${score.toFixed(1)}/10 (${tier}) on GradeThread.`;
  // The viral hook only renders when a referral code is actually baked in, so
  // we never promise "we both earn credits" on an unattributed share.
  const text = referralCode
    ? `${baseText} Grade yours — join with my link and we both earn grade credits.`
    : baseText;
  const emailSubject = `${title} — GradeThread condition grade ${score.toFixed(1)}/10`;

  // US-1288: one-tap share to major socials. Each carries the same referral
  // link, so the unfurl (cert OG → slab image) and the attribution travel
  // together. Pinterest gets the slab image directly as its pin media.
  const channels: { key: string; label: string; href: string }[] = [
    {
      key: "x",
      label: "X",
      href: `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(channelUrl("x"))}`,
    },
    {
      key: "facebook",
      label: "Facebook",
      href: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(channelUrl("facebook"))}`,
    },
    {
      key: "pinterest",
      label: "Pinterest",
      href: `https://pinterest.com/pin/create/button/?url=${encodeURIComponent(channelUrl("pinterest"))}&media=${encodeURIComponent(slabImage)}&description=${encodeURIComponent(text)}`,
    },
    {
      key: "whatsapp",
      label: "WhatsApp",
      href: `https://wa.me/?text=${encodeURIComponent(`${text} ${channelUrl("whatsapp")}`)}`,
    },
    {
      key: "reddit",
      label: "Reddit",
      href: `https://www.reddit.com/submit?url=${encodeURIComponent(channelUrl("reddit"))}&title=${encodeURIComponent(baseText)}`,
    },
    {
      key: "email",
      label: "Email",
      href: `mailto:?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(`${text} ${channelUrl("email")}`)}`,
    },
  ];

  function openChannel(channel: { key: string; href: string }) {
    track("cert_share", {
      certificate_id: certificateId,
      method: "channel",
      channel: channel.key,
      referral: Boolean(referralCode),
    });
    reportShare(channel.key);
    if (typeof window !== "undefined") {
      window.open(channel.href, "_blank", "noopener,noreferrer");
    }
  }

  async function share() {
    setSharing(true);
    try {
      const nav = navigator as Navigator & {
        canShare?: (data?: ShareData) => boolean;
      };

      // Desktop Chrome/Edge on Windows implement navigator.share, so testing
      // for its existence sent desktop users into the OS share sheet — a modal
      // offering Mail and nearby-sharing that cannot post to X and reads as the
      // button being broken. prefersNativeShare() also requires a coarse
      // primary pointer, so phones and tablets keep the sheet (it reaches
      // native apps, and carries the slab image) and desktop copies the link.
      if (prefersNativeShare()) {
        // Try to attach the graded photo so the share carries the image, not
        // just a link — but only when the platform accepts files.
        let files: File[] | undefined;
        try {
          const res = await fetch(slabImage);
          if (res.ok) {
            const file = new File([await res.blob()], "gradethread-grade.png", {
              type: "image/png",
            });
            if (nav.canShare?.({ files: [file] })) files = [file];
          }
        } catch {
          /* image attach is best-effort */
        }

        await nav.share(
          files ? { title, text, url, files } : { title, text, url },
        );
        track("cert_share", {
          certificate_id: certificateId,
          method: "web_share",
          channel: "native",
          referral: Boolean(referralCode),
        });
        reportShare("native");
        return;
      }

      // Desktop, or no Web Share API → copy the link.
      await navigator.clipboard.writeText(url);
      toast.success("Certificate link copied");
      track("cert_share", {
        certificate_id: certificateId,
        method: "copy",
        channel: "clipboard",
        referral: Boolean(referralCode),
      });
      reportShare("clipboard");
    } catch (err) {
      // User dismissing the share sheet throws AbortError — not an error.
      if ((err as Error)?.name === "AbortError") return;
      try {
        await navigator.clipboard.writeText(url);
        toast.success("Certificate link copied");
        track("cert_share", {
          certificate_id: certificateId,
          method: "copy",
          channel: "clipboard",
          referral: Boolean(referralCode),
        });
        reportShare("clipboard");
      } catch {
        toast.error("Couldn't share — copy the link from your browser.");
      }
    } finally {
      setSharing(false);
    }
  }

  function printCert() {
    track("cert_print", { certificate_id: certificateId });
    window.print();
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={share} disabled={sharing}>
          <Share2 className="mr-1.5 h-4 w-4" />
          Share
        </Button>
        <Button variant="outline" size="sm" onClick={printCert}>
          <Printer className="mr-1.5 h-4 w-4" />
          Save as PDF
        </Button>
      </div>
      {/* US-1288: one-tap social channels. When the sharer is signed in these
          carry their referral code, so a grade share also recruits sellers. */}
      <div className="flex flex-wrap items-center justify-end gap-1.5">
        {referralCode && (
          <span className="mr-0.5 text-xs text-muted-foreground">Share &amp; earn:</span>
        )}
        {channels.map((channel) => (
          <Button
            key={channel.key}
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={() => openChannel(channel)}
          >
            {channel.label}
          </Button>
        ))}
      </div>
      {/* US-1854: the earn half, made visible. Only renders once this find has
          actually been shared, so a buyer viewing a stranger's certificate (who
          gets zeros from the owner-scoped endpoint) sees nothing at all. */}
      {shareStats && shareStats.shares > 0 && (
        <p className="max-w-[46ch] text-right text-xs text-muted-foreground">
          {shareStats.verified_clicks === 0
            ? "Shared. You earn when someone actually opens it."
            : `${shareStats.verified_clicks} verified click-${shareStats.verified_clicks === 1 ? "through" : "throughs"}.`}
          {shareStats.next_milestone && (
            <>
              {" "}
              {shareStats.next_milestone.clicks - shareStats.verified_clicks} more
              to earn {shareStats.next_milestone.xp} XP.
            </>
          )}
        </p>
      )}
    </div>
  );
}
