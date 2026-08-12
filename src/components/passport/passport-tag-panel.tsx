import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { QrCode, Printer, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { edgeFetch } from "@/lib/edge-fetch";

// US-1096: owner-facing physical-tag generator. Issues a printable QR + short
// code bound to the garment's passport. Opt-in, surfaced where the owner views
// their graded item. Scanning the QR opens /t/:code (public) → the passport,
// with a deterministic scan-to-claim handoff (Layer 1, US-1094).

interface PassportTagPanelProps {
  /** The garment whose passport the tag is bound to. */
  garmentId: string;
}

interface IssuedTag {
  tagId: string;
  shortCode: string;
  scanUrl: string;
}

export function PassportTagPanel({ garmentId }: PassportTagPanelProps) {
  const [tag, setTag] = useState<IssuedTag | null>(null);
  const [issuing, setIssuing] = useState(false);

  async function issue(replaceExisting: boolean) {
    setIssuing(true);
    try {
      const res = await edgeFetch(`/api/passport/garments/${garmentId}/tags`, {
        method: "POST",
        json: { revoke_existing: replaceExisting },
      });
      if (!res.ok) throw new Error(`issue failed: ${res.status}`);
      const data = (await res.json()) as {
        tag_id: string;
        short_code: string;
        scan_url: string;
      };
      setTag({ tagId: data.tag_id, shortCode: data.short_code, scanUrl: data.scan_url });
      toast.success(replaceExisting ? "New tag issued — prior tags revoked" : "Passport tag issued");
    } catch {
      toast.error("Couldn't issue a passport tag. Please try again.");
    } finally {
      setIssuing(false);
    }
  }

  function printTag() {
    if (!tag) return;
    const w = window.open("", "_blank", "width=420,height=560");
    if (!w) {
      toast.error("Enable pop-ups to print the tag.");
      return;
    }
    // Self-contained print doc — the QR SVG is re-encoded from the scan URL by
    // the print window's own QR rendering is unavailable, so we inline the SVG.
    const svg = document.getElementById(`passport-tag-qr-${tag.tagId}`)?.outerHTML ?? "";
    w.document.write(`<!doctype html><html><head><title>Garment Passport Tag</title>
      <style>body{font:14px system-ui,sans-serif;text-align:center;padding:32px;color:#0F3460}
      .code{font-size:20px;font-weight:700;letter-spacing:2px;margin-top:12px}
      .hint{color:#6b7280;font-size:12px;margin-top:8px}</style></head>
      <body><div>${svg}</div><div class="code">${tag.shortCode}</div>
      <div class="hint">Scan or enter this code at gradethread.com to view this garment's passport.</div>
      </body></html>`);
    w.document.close();
    w.focus();
    w.print();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <QrCode className="h-4 w-4" />
          Physical Passport Tag
        </CardTitle>
        <CardDescription>
          Attach a scannable tag for a hand-off in person. Whoever holds the tag can
          scan it to view the full history and claim ownership, and it keeps working
          until you reissue or revoke it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!tag ? (
          <Button onClick={() => issue(false)} disabled={issuing}>
            {issuing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Issuing…
              </>
            ) : (
              <>
                <QrCode className="mr-2 h-4 w-4" /> Generate tag
              </>
            )}
          </Button>
        ) : (
          <div className="flex flex-col items-center gap-4">
            <div className="rounded-lg border bg-white p-4">
              <QRCodeSVG
                id={`passport-tag-qr-${tag.tagId}`}
                value={tag.scanUrl}
                size={160}
                level="M"
                marginSize={2}
              />
            </div>
            <div className="text-center">
              <p className="font-mono text-lg font-bold tracking-widest text-brand-navy dark:text-foreground">
                {tag.shortCode}
              </p>
              <p className="text-xs text-muted-foreground">
                Printed on the tag — scannable or hand-enterable.
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="outline" size="sm" onClick={printTag}>
                <Printer className="mr-2 h-4 w-4" /> Print tag
              </Button>
              <Button variant="ghost" size="sm" onClick={() => issue(true)} disabled={issuing}>
                <RefreshCw className="mr-2 h-4 w-4" /> Reissue (revoke old)
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
