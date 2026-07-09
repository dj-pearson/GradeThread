import { useMemo, useState } from "react";
import { BadgeCheck, History } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyField } from "@/components/verified/copy-field";
import { useMyCertificates, type BadgeCertificate } from "@/hooks/use-badge-studio";
import {
  BADGE_FORMATS,
  type BadgeFormatId,
  certBadgeEmbedHtml,
  certBadgeEmbedText,
  certBadgeScriptEmbed,
  certBadgeUrl,
  parseCertificateRef,
  passportBadgeEmbedHtml,
  passportBadgeEmbedText,
} from "@/lib/verified";

// US-1759: Badge Studio — one place to grab the right verified-badge snippet for
// each marketplace. Pick a certificate (or paste any of your certificate links),
// then copy the image / script / text format, with per-marketplace guidance and
// a live preview. When the certificate has a Garment Passport, a passport badge
// (advertising the item's full history) is offered too.

function certLabel(c: BadgeCertificate): string {
  const date = c.finalizedAt
    ? new Date(c.finalizedAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "";
  const grade = `Grade ${c.overallScore.toFixed(1)} · ${c.gradeTier}`;
  return date ? `${grade} · ${date}` : grade;
}

function snippetFor(format: BadgeFormatId, certId: string): string {
  switch (format) {
    case "image":
      return certBadgeEmbedHtml(certId);
    case "script":
      return certBadgeScriptEmbed(certId);
    case "text":
      return certBadgeEmbedText(certId);
  }
}

export function BadgeStudio() {
  const { data: certs, isLoading } = useMyCertificates();
  const [selectedId, setSelectedId] = useState<string>("");
  const [pasted, setPasted] = useState("");
  const [format, setFormat] = useState<BadgeFormatId>("image");

  // A pasted certificate link/id wins over the dropdown, so a seller can badge a
  // certificate that isn't in their recent list (or before it loads).
  const pastedId = useMemo(() => parseCertificateRef(pasted), [pasted]);
  const activeCertId = pastedId ?? (selectedId || null);

  const selectedCert = useMemo(
    () => (certs ?? []).find((c) => c.certificateId === activeCertId) ?? null,
    [certs, activeCertId],
  );
  // Passport variant is only offered when we know the cert's slug — i.e. it's
  // one of the seller's own listed certs. A pasted-only id has no known passport.
  const passportSlug = selectedCert?.passportSlug ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BadgeCheck className="h-5 w-5 text-brand-navy dark:text-foreground" />
          Badge Studio
        </CardTitle>
        <CardDescription>
          Grab the right verified-badge snippet for each marketplace. Pick a
          graded item, then copy the format that works where you're listing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Certificate picker */}
        <div className="space-y-1.5">
          <Label htmlFor="badge-cert">Certificate</Label>
          {isLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : (certs ?? []).length > 0 ? (
            <Select value={selectedId} onValueChange={setSelectedId}>
              <SelectTrigger id="badge-cert">
                <SelectValue placeholder="Choose a graded item…" />
              </SelectTrigger>
              <SelectContent>
                {(certs ?? []).map((c) => (
                  <SelectItem key={c.certificateId} value={c.certificateId}>
                    {certLabel(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-sm text-muted-foreground">
              No certificates yet — grade an item to get a badge. You can also
              paste a certificate link below.
            </p>
          )}
        </div>

        {/* Paste-any-certificate fallback */}
        <div className="space-y-1.5">
          <Label htmlFor="badge-paste">…or paste a certificate link</Label>
          <Input
            id="badge-paste"
            value={pasted}
            spellCheck={false}
            autoCapitalize="none"
            placeholder="https://gradethread.com/cert/…"
            onChange={(e) => setPasted(e.target.value)}
          />
          {pasted.trim() && !pastedId && (
            <p className="text-xs text-red-600 dark:text-red-400">
              That doesn't look like a certificate link.
            </p>
          )}
        </div>

        {!activeCertId ? (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            Pick or paste a certificate to see its badge snippets.
          </div>
        ) : (
          <>
            {/* Format tabs */}
            <Tabs value={format} onValueChange={(v) => setFormat(v as BadgeFormatId)}>
              <TabsList className="grid w-full grid-cols-3">
                {BADGE_FORMATS.map((f) => (
                  <TabsTrigger key={f.id} value={f.id}>
                    {f.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              {BADGE_FORMATS.map((f) => (
                <TabsContent key={f.id} value={f.id} className="space-y-3 pt-3">
                  <p className="text-sm text-muted-foreground">{f.hint}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {f.worksOn.map((m) => (
                      <span
                        key={m}
                        className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
                      >
                        {m}
                      </span>
                    ))}
                  </div>

                  {/* Live preview */}
                  <div className="rounded-lg border bg-muted/30 p-4">
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Preview
                    </p>
                    <BadgePreview format={f.id} certId={activeCertId} />
                  </div>

                  <CopyField
                    label="Copy this snippet"
                    value={snippetFor(f.id, activeCertId)}
                    multiline
                  />
                </TabsContent>
              ))}
            </Tabs>

            {/* Passport variant — only when this certificate has a passport. */}
            {passportSlug && (
              <div className="space-y-3 rounded-lg border p-4">
                <div className="flex items-center gap-2">
                  <History className="h-4 w-4 text-brand-navy dark:text-foreground" />
                  <p className="text-sm font-medium">
                    Advertise the full history (Garment Passport)
                  </p>
                </div>
                <p className="text-sm text-muted-foreground">
                  Links to this item's complete public record — every grade,
                  listing and ownership hop. There's no passport image, so use the
                  HTML link where HTML is allowed and the text elsewhere.
                </p>
                <CopyField
                  label="HTML link (eBay, websites)"
                  value={passportBadgeEmbedHtml(passportSlug)}
                  multiline
                />
                <CopyField
                  label="Text + link (Poshmark, Grailed, Mercari, Depop)"
                  value={passportBadgeEmbedText(passportSlug)}
                  multiline
                />
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// The live preview for each format. The image badge and (representatively) the
// script embed render the real /badge/cert asset; the text format shows the
// exact string a marketplace would display.
function BadgePreview({ format, certId }: { format: BadgeFormatId; certId: string }) {
  if (format === "text") {
    return (
      <span className="text-sm">
        ✓ GradeThread Verified condition grade — verify:{" "}
        <span className="text-brand-navy underline dark:text-foreground">
          gradethread.com/cert/…
        </span>
      </span>
    );
  }
  // image + script both render the badge image asset.
  return (
    <div className="space-y-1">
      <img
        src={certBadgeUrl(certId)}
        alt="GradeThread Verified condition grade badge"
        width={350}
        height={90}
        style={{ maxWidth: "100%", height: "auto", border: 0 }}
      />
      {format === "script" && (
        <p className="text-xs text-muted-foreground">
          Renders automatically wherever scripts run.
        </p>
      )}
    </div>
  );
}
