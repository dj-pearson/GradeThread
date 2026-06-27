import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Printer, Share2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { track } from "@/lib/analytics";
import { SITE_URL } from "@/lib/seo/public-routes";
import { useAuthStore } from "@/stores/auth-store";
import { edgeFetch } from "@/lib/edge-fetch";

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

interface ReferralMe {
  code: string;
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

  const origin =
    typeof window !== "undefined" ? window.location.origin : SITE_URL;
  // ?s=share lets a shared-link view be attributed (US-769) without any PII.
  // When the sharer has a referral code, append it (+ utm_source=certificate)
  // so captureAffiliateRef() attributes any signup that follows from the share.
  const refSuffix = referralCode
    ? `&ref=${encodeURIComponent(referralCode)}&utm_source=certificate`
    : "";
  const url = `${origin}/cert/${certificateId}?s=share${refSuffix}`;
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
      href: `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
    },
    {
      key: "facebook",
      label: "Facebook",
      href: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
    },
    {
      key: "pinterest",
      label: "Pinterest",
      href: `https://pinterest.com/pin/create/button/?url=${encodeURIComponent(url)}&media=${encodeURIComponent(slabImage)}&description=${encodeURIComponent(text)}`,
    },
    {
      key: "whatsapp",
      label: "WhatsApp",
      href: `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`,
    },
    {
      key: "reddit",
      label: "Reddit",
      href: `https://www.reddit.com/submit?url=${encodeURIComponent(url)}&title=${encodeURIComponent(baseText)}`,
    },
    {
      key: "email",
      label: "Email",
      href: `mailto:?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(`${text} ${url}`)}`,
    },
  ];

  function openChannel(channel: { key: string; href: string }) {
    track("cert_share", {
      certificate_id: certificateId,
      method: "channel",
      channel: channel.key,
      referral: Boolean(referralCode),
    });
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

      if (typeof nav.share === "function") {
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
        return;
      }

      // No Web Share API → copy the link.
      await navigator.clipboard.writeText(url);
      toast.success("Certificate link copied");
      track("cert_share", {
        certificate_id: certificateId,
        method: "copy",
        channel: "clipboard",
        referral: Boolean(referralCode),
      });
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
    </div>
  );
}
