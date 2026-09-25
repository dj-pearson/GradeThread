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
import { Switch } from "@/components/ui/switch";
import { CopyField } from "@/components/verified/copy-field";
import { Button } from "@/components/ui/button";
import {
  useMyCertificates,
  useOwnedCertificate,
  type BadgeCertificate,
} from "@/hooks/use-badge-studio";
import {
  BADGE_FORMATS,
  type BadgeFormatId,
  type BadgeVariant,
  certBadgeEmbedHtml,
  certBadgeEmbedText,
  certBadgeScriptEmbed,
  certBadgeUrl,
  parseCertificateRef,
  passportBadgeEmbedHtml,
  passportBadgeEmbedText,
  SELLER_BADGE_FORMAT_OPTIONS,
  type SellerBadgeFormat,
  verifiedSellerBadgeEmbedHtml,
  verifiedSellerBadgeEmbedText,
  verifiedSellerBadgeUrl,
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
  // Named by the item first: two grades of 8.5 are otherwise the same line,
  // and the wrong garment's badge ends up in a listing.
  const parts = [
    c.title?.trim() || "Untitled item",
    c.brand?.trim() || "",
    `${c.overallScore.toFixed(1)} ${c.gradeTier}`,
    date,
  ].filter(Boolean);
  return parts.join(" · ");
}

function certItemName(c: BadgeCertificate): string {
  return [c.title?.trim() || "Untitled item", c.brand?.trim() || ""]
    .filter(Boolean)
    .join(" · ");
}

function snippetFor(
  format: BadgeFormatId,
  certId: string,
  variant: BadgeVariant,
): string {
  switch (format) {
    case "image":
      return certBadgeEmbedHtml(certId, variant);
    case "script":
      return certBadgeScriptEmbed(certId, variant);
    case "text":
      // The text badge has no artwork to redraw, so it has no status variant —
      // a tier typed into a listing description would freeze at paste time.
      return certBadgeEmbedText(certId);
  }
}

// US-1913 AC1: the plain/status switch, offered once per embed. Opt-in, and
// off by default — a seller's standing goes on somebody else's storefront only
// because they chose to put it there.
function StatusToggle({
  id,
  checked,
  onChange,
  hint,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg bg-muted/40 p-3">
      <div className="space-y-0.5">
        <Label htmlFor={id} className="text-sm font-medium">
          Show my status on the badge
        </Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

// One sentence, used under both toggles, that says what the badge will and will
// not claim. The "only once you've earned them" half is not marketing softener:
// below the confirmed-outcome floor the edge renders the plain badge, so a
// seller who flips this on early sees exactly what they had.
const STATUS_HINT =
  "Adds your Grade Integrity tier, level and confirmed-accuracy share — but " +
  "only once you've earned them. The image is redrawn on every view, so your " +
  "badge stays current without re-pasting the code.";

export function BadgeStudio({ handle }: { handle?: string | null }) {
  const {
    data: certs,
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useMyCertificates();
  const [selectedId, setSelectedId] = useState<string>("");
  const [pasted, setPasted] = useState("");
  const [format, setFormat] = useState<BadgeFormatId>("image");
  const [sellerFormat, setSellerFormat] = useState<SellerBadgeFormat>("wide");
  // US-1913: plain vs status, chosen per embed. The two badges are independent
  // — a seller may want their standing on their storefront banner but not on
  // every listing, or the reverse.
  const [sellerStatus, setSellerStatus] = useState(false);
  const [certStatus, setCertStatus] = useState(false);
  const sellerVariant: BadgeVariant = sellerStatus ? "status" : "plain";
  const certVariant: BadgeVariant = certStatus ? "status" : "plain";

  // A pasted certificate link/id wins over the dropdown, so a seller can badge a
  // certificate that isn't in their recent list (or before it loads). It must
  // still be one of THEIR certificates: any public id would otherwise produce
  // "GradeThread Verified" snippets for someone else's grade.
  const pastedId = useMemo(() => parseCertificateRef(pasted), [pasted]);
  const listedPasted = useMemo(
    () => (pastedId ? (certs ?? []).find((c) => c.certificateId === pastedId) ?? null : null),
    [certs, pastedId],
  );
  const needsLookup = !!pastedId && !listedPasted && !isLoading;
  const ownedLookup = useOwnedCertificate(needsLookup ? pastedId : null);

  const selectedCert: BadgeCertificate | null = useMemo(() => {
    if (pastedId) {
      if (listedPasted) return listedPasted;
      return ownedLookup.data?.state === "owned" ? ownedLookup.data.cert : null;
    }
    return (certs ?? []).find((c) => c.certificateId === selectedId) ?? null;
  }, [pastedId, listedPasted, ownedLookup.data, certs, selectedId]);
  const activeCertId = selectedCert?.certificateId ?? null;
  const passportSlug = selectedCert?.passportSlug ?? null;

  function onPaste(value: string) {
    setPasted(value);
    // A paste that resolves to an id replaces the dropdown choice, so the two
    // never disagree about which item the snippets are for.
    if (parseCertificateRef(value)) setSelectedId("");
  }

  function onSelect(id: string) {
    setSelectedId(id);
    setPasted("");
  }

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
        {/* Storefront (seller-level) badge — advertises your whole track record.
            Only shown once the profile has a public handle. */}
        {handle && (
          <div className="space-y-3 rounded-lg border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">Storefront badge (your whole profile)</p>
              <Select
                value={sellerFormat}
                onValueChange={(v) => setSellerFormat(v as SellerBadgeFormat)}
              >
                <SelectTrigger className="h-8 w-40" aria-label="Storefront badge format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SELLER_BADGE_FORMAT_OPTIONS.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.label} ({o.width}×{o.height})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <StatusToggle
              id="seller-badge-status"
              checked={sellerStatus}
              onChange={setSellerStatus}
              hint={STATUS_HINT}
            />
            <div className="rounded-lg border bg-muted/30 p-4">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Preview
              </p>
              <img
                src={verifiedSellerBadgeUrl(handle, sellerFormat, sellerVariant)}
                alt="GradeThread Verified Seller badge"
                className="max-w-full"
              />
            </div>
            <CopyField
              label="HTML (eBay, websites)"
              value={verifiedSellerBadgeEmbedHtml(handle, sellerFormat, sellerVariant)}
              multiline
            />
            <CopyField
              label="Text + link (Poshmark, Grailed, Mercari, Depop)"
              value={verifiedSellerBadgeEmbedText(handle)}
              multiline
            />
          </div>
        )}

        {/* Certificate picker */}
        <div className="space-y-1.5">
          <Label htmlFor="badge-cert">Certificate</Label>
          {isLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : isError ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-red-600 dark:text-red-400">
                Couldn't load your certificates.
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => refetch()}
                disabled={isFetching}
              >
                Retry
              </Button>
            </div>
          ) : (certs ?? []).length > 0 ? (
            <Select value={selectedId} onValueChange={onSelect}>
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
            onChange={(e) => onPaste(e.target.value)}
          />
          {pasted.trim() && !pastedId && (
            <p className="text-xs text-red-600 dark:text-red-400">
              That doesn't look like a certificate link.
            </p>
          )}
          {needsLookup && ownedLookup.isLoading && (
            <p className="text-xs text-muted-foreground">Checking that certificate...</p>
          )}
          {needsLookup && ownedLookup.isError && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              Couldn't check that certificate.{" "}
              <button
                type="button"
                className="font-medium underline"
                onClick={() => ownedLookup.refetch()}
              >
                Retry
              </button>
            </p>
          )}
          {needsLookup && ownedLookup.data?.state === "not_owned" && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              This certificate isn't one of yours.
            </p>
          )}
          {needsLookup && ownedLookup.data?.state === "not_public" && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              This certificate isn't public yet, so its badge wouldn't show.
            </p>
          )}
        </div>

        {!activeCertId || !selectedCert ? (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            Pick or paste a certificate to see its badge snippets.
          </div>
        ) : (
          <>
            <p className="text-sm">
              Snippets for <span className="font-medium">{certItemName(selectedCert)}</span>
            </p>
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

                  {/* US-1913: the status variant applies to the rendered badge
                      image, so it is offered on the image + script formats only. */}
                  {f.id !== "text" && (
                    <StatusToggle
                      id={`cert-badge-status-${f.id}`}
                      checked={certStatus}
                      onChange={setCertStatus}
                      hint={STATUS_HINT}
                    />
                  )}

                  {/* Live preview */}
                  <div className="rounded-lg border bg-muted/30 p-4">
                    <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Preview
                    </p>
                    <BadgePreview
                      format={f.id}
                      certId={activeCertId}
                      variant={certVariant}
                    />
                  </div>

                  <CopyField
                    label="Copy this snippet"
                    value={snippetFor(f.id, activeCertId, certVariant)}
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
function BadgePreview({
  format,
  certId,
  variant,
}: {
  format: BadgeFormatId;
  certId: string;
  variant: BadgeVariant;
}) {
  if (format === "text") {
    return (
      <span className="text-sm">
        ✓ GradeThread Verified condition grade. Verify it:{" "}
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
        src={certBadgeUrl(certId, variant)}
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
