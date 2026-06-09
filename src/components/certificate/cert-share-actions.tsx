import { useState } from "react";
import { Printer, Share2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { track } from "@/lib/analytics";
import { SITE_URL } from "@/lib/seo/public-routes";

// US-767 (implements US-607): turn the certificate into a first-class
// shareable. Native share sheet (with the slab image where supported) + a
// copy-link fallback, and a print / "Save as PDF" action. The shared link
// unfurls via the cert OG image (US-307).

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

  const origin =
    typeof window !== "undefined" ? window.location.origin : SITE_URL;
  // ?s=share lets a shared-link view be attributed (US-769) without any PII.
  const url = `${origin}/cert/${certificateId}?s=share`;
  const text = `${title} — verified condition grade ${score.toFixed(1)}/10 (${tier}) on GradeThread.`;

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
          const res = await fetch(
            `${origin}/slab/cert/${encodeURIComponent(certificateId)}?format=square`,
          );
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
        track("cert_share", { certificate_id: certificateId, method: "web_share" });
        return;
      }

      // No Web Share API → copy the link.
      await navigator.clipboard.writeText(url);
      toast.success("Certificate link copied");
      track("cert_share", { certificate_id: certificateId, method: "copy" });
    } catch (err) {
      // User dismissing the share sheet throws AbortError — not an error.
      if ((err as Error)?.name === "AbortError") return;
      try {
        await navigator.clipboard.writeText(url);
        toast.success("Certificate link copied");
        track("cert_share", { certificate_id: certificateId, method: "copy" });
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
  );
}
