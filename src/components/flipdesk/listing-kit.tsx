import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  Puzzle,
  Wand2,
} from "lucide-react";
import { Link } from "react-router";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import {
  charStatus,
  type DraftFields,
  type FieldIssue,
  getMarketplaceSpec,
  manualKitPlatforms,
  type FieldSpec,
  type MarketplacePlatform,
  validateListingForPlatform,
} from "@/lib/marketplace-specs";
import {
  type PlatformKitVariant,
  useGeneratePlatformFields,
} from "@/hooks/use-autolister";
import {
  type ExportablePhoto,
  exportPhotosForPlatform,
} from "@/lib/photo-export";
import {
  buildListerPayload,
  extensionWebStoreUrl,
  isListerAvailable,
  isListerPlatform,
  listerUnavailableReason,
  onListerListed,
  sendToLister,
} from "@/lib/lister-extension";
import { MARKETPLACE_EXTENSION_FLOW } from "@/lib/constants";
import { edgeFetch } from "@/lib/edge-fetch";
import {
  QUEUED_NOTICE,
  useEnqueueExtensionWork,
} from "@/hooks/use-extension-queue";

// Copy-paste targets: the no-API platforms (Poshmark/Mercari/Grailed) plus
// Depop until its partner API is live (US-712/713/714). Shopify + eBay push via
// their adapters, so they're not copy-paste targets.
const KIT_PLATFORMS: MarketplacePlatform[] = [
  "poshmark",
  "mercari",
  "depop",
  "grailed",
  // 2026-08-11. Vinted's lister flow went live the same day and there was no
  // way to reach it: the extension accepted a Vinted job, the content script was
  // installed on all 22 country domains, and the app had no button that sent
  // one. This list is hand-written and predated the channel.
  //
  // Facebook is deliberately still absent — its flow is `enabled: false` in
  // selectors.js, so a tab here would offer a send that reports "list manually".
  // Add it when that flips, not before.
  "vinted",
].filter((p) =>
  p === "depop" ? true : manualKitPlatforms().includes(p as MarketplacePlatform),
) as MarketplacePlatform[];

// Where to send the seller to create the listing manually.
const NEW_LISTING_URL: Partial<Record<MarketplacePlatform, string>> = {
  poshmark: "https://poshmark.com/create-listing",
  mercari: "https://www.mercari.com/sell/",
  depop: "https://www.depop.com/sell/",
  grailed: "https://www.grailed.com/sell/",
};

// Maps a registry field key to its value in a generated variant.
function fieldValue(key: string, v: PlatformKitVariant): string {
  switch (key) {
    case "title":
      return v.title;
    case "description":
      return v.description;
    case "category":
    case "department":
    case "productType":
      return v.category;
    case "condition":
      return v.condition?.label ?? "";
    case "brand":
    case "designer":
    case "vendor":
      return v.brand ?? "";
    case "color":
      return v.color ?? "";
    case "size":
      return v.size ?? "";
    case "tags":
      return v.tags.join(" ");
    case "price":
    case "originalPrice":
      return v.price ? String(v.price) : "";
    case "nwt":
      return v.condition?.value === "NWT" ? "Yes" : "No";
    default:
      return "";
  }
}

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch {
    toast.error("Couldn't copy — your browser blocked clipboard access.");
  }
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 shrink-0 px-2 text-xs"
      disabled={!text}
      onClick={async () => {
        await copy(text, label);
        setDone(true);
        window.setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  );
}

interface KitFieldProps {
  field: FieldSpec;
  value: string;
  editable: boolean;
  onChange: (v: string) => void;
}

function KitField({ field, value, editable, onChange }: KitFieldProps) {
  const status = charStatus(value, field.maxLength);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs font-medium">
          {field.label}
          {field.required && <span className="ml-0.5 text-brand-red-text">*</span>}
        </Label>
        <div className="flex items-center gap-1">
          {field.maxLength != null && (
            <span
              className={cn(
                "text-[11px] tabular-nums",
                status.over ? "font-semibold text-brand-red-text" : "text-muted-foreground",
              )}
            >
              {status.length}/{field.maxLength}
            </span>
          )}
          <CopyButton text={value} label={field.label} />
        </div>
      </div>
      {editable && field.multiline ? (
        <Textarea
          aria-label={field.label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-[88px] text-sm"
        />
      ) : editable ? (
        <Input aria-label={field.label} value={value} onChange={(e) => onChange(e.target.value)} className="text-sm" />
      ) : (
        <div className="whitespace-pre-wrap rounded-md border bg-muted/40 px-3 py-2 text-sm">
          {value || <span className="text-muted-foreground">—</span>}
        </div>
      )}
    </div>
  );
}

function PlatformPanel({
  platform,
  variant,
  fallbackPrice,
  photos,
  primaryId,
  baseName,
  itemId,
}: {
  platform: MarketplacePlatform;
  variant: PlatformKitVariant | undefined;
  /** US-2736: used when the stored variant carries no price. 0 means none. */
  fallbackPrice: number;
  photos: ExportablePhoto[];
  primaryId: string | null;
  baseName: string;
  itemId: string;
}) {
  const qc = useQueryClient();
  const spec = getMarketplaceSpec(platform);
  // Local edits to the free-text fields, keyed by field key.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [downloading, setDownloading] = useState(false);
  const [sending, setSending] = useState(false);
  // US-1877 (AC2): a prefill records a DRAFT. This surfaces the control that
  // promotes it once the seller has actually hit Submit on the marketplace.
  const [prefilled, setPrefilled] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // US-2720: set only by an explicit needsUpgrade answer FROM the extension —
  // never inferred from the plan we think the account is on, because the
  // extension is the thing enforcing it.
  const [needsUpgrade, setNeedsUpgrade] = useState(false);

  // US-1877 (AC1): the AUTOMATIC path — the extension saw the tab navigate to the
  // live listing, which means the seller submitted. Promote the draft and record
  // the real URL without making them click anything.
  //
  // Scoped to THIS panel's item + platform: a seller can have several kits open,
  // and promoting the wrong row would put a real URL on the wrong listing.
  useEffect(() => {
    return onListerListed((e) => {
      if (e.platform !== platform) return;
      if (e.itemId && e.itemId !== itemId) return;
      void (async () => {
        try {
          const wb = await edgeFetch("/api/flipdesk/listings/extension-writeback", {
            method: "POST",
            json: {
              item_id: itemId,
              platform,
              published: true,
              listing_url: e.listingUrl,
            },
          });
          if (!wb.ok) return; // "I published it" is still there as the fallback
          setPrefilled(false);
          toast.success(`${spec?.label ?? platform} listing is live — recorded in FlipDesk.`);
          void qc.invalidateQueries({ queryKey: ["platform-fields", itemId] });
          void qc.invalidateQueries({ queryKey: ["item_listing_platforms"] });
        } catch {
          // Silent: the seller never asked for this, and the manual path covers it.
        }
      })();
    });
  }, [platform, itemId, qc, spec?.label]);

  if (!spec) return null;

  const photoCount = photos.length;
  const inZip = Math.min(photoCount, spec.maxPhotos);

  const downloadPhotos = async () => {
    setDownloading(true);
    try {
      const { count, skipped } = await exportPhotosForPlatform({
        photos,
        primaryId,
        platform,
        baseName,
      });
      toast.success(
        `${count} photo${count === 1 ? "" : "s"} zipped for ${spec.label}` +
          (skipped > 0 ? ` (${skipped} skipped)` : ""),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't export photos.");
    } finally {
      setDownloading(false);
    }
  };


  // US-1877 (AC2): the explicit "I published it" path.
  //
  // The automatic path is the extension capturing the live URL after the seller
  // submits (AC1). This is the fallback for when that window is missed — the seller
  // took ten minutes over the form, or closed and reopened the tab. Without it a
  // real live listing would be stuck as a draft forever, which is the mirror of the
  // phantom-active bug and just as wrong.
  const confirmPublished = async () => {
    setConfirming(true);
    try {
      const wb = await edgeFetch("/api/flipdesk/listings/extension-writeback", {
        method: "POST",
        json: { item_id: itemId, platform, published: true },
      });
      if (!wb.ok) {
        const j = await wb.json().catch(() => ({}));
        toast.error(j.error ?? `Couldn't record the ${spec.label} listing.`);
        return;
      }
      toast.success(`${spec.label} listing recorded as live.`);
      setPrefilled(false);
      void qc.invalidateQueries({ queryKey: ["platform-fields", itemId] });
      void qc.invalidateQueries({ queryKey: ["item_listing_platforms"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't record the listing.");
    } finally {
      setConfirming(false);
    }
  };

  if (!variant) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Not generated yet — click “Generate for all marketplaces” above.
      </p>
    );
  }

  // title/description + the platform category are editable (the seller confirms
  // the seeded category / department — US-722); the rest is copy-only display.
  const editableKeys = new Set(["title", "description", "category", "department"]);
  // US-2736: one resolved variant, so the DISPLAYED price, the validation that
  // decides "Ready to list", and the payload the extension receives can never
  // disagree about what this item costs. Patching only the render would have
  // shown a price the extension still refused to type.
  const priced: PlatformKitVariant =
    variant.price > 0 || fallbackPrice <= 0
      ? variant
      : { ...variant, price: fallbackPrice };
  const valueOf = (f: FieldSpec) =>
    edits[f.key] ?? fieldValue(f.key, priced);

  // US-725: re-validate the *edited* draft live against the platform's
  // requirements registry (not just the stale generation-time result), so an
  // over-limit title or cleared category the seller just typed blocks "ready"
  // immediately. condition/tags are projected onto the registry's value shape
  // (validateListingForPlatform matches condition against spec.conditions[].value
  // and counts the tag array). Errors block copy/send; warnings are advisory.
  const liveDraft: DraftFields = {};
  for (const f of spec.fields) {
    if (f.key === "condition") liveDraft.condition = variant.condition?.value ?? "";
    else if (f.key === "tags") liveDraft.tags = variant.tags;
    else liveDraft[f.key] = valueOf(f);
  }
  const live = validateListingForPlatform(platform, liveDraft);
  const issues: FieldIssue[] = [...live.issues];
  // Photo cap is non-blocking in the kit: the export (US-724) auto-caps to the
  // platform max and reports what it skipped, so surface it as a warning rather
  // than a hard error that would needlessly block copy.
  if (photoCount > spec.maxPhotos) {
    issues.push({
      field: "photos",
      level: "warning",
      message: `${photoCount} photos — only the first ${spec.maxPhotos} will be exported for ${spec.label}`,
    });
  }
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  const ready = errors.length === 0;

  const copyAll = () => {
    if (errors.length > 0) {
      toast.error("Fix the blocking issues before copying this listing.");
      return;
    }
    const block = spec.fields
      .map((f) => `${f.label}: ${valueOf(f)}`)
      .join("\n");
    void copy(block, `${spec.label} listing`);
  };

  // US-716: hand this platform's draft to the GradeThread Lister extension,
  // which prefills the marketplace's native form in the seller's own tab. The
  // extension never touches GradeThread auth or marketplace creds — once it
  // reports the form was filled, WE record the cross-listing via the writeback
  // endpoint using the user's SaaS session.
  const showSend = isListerAvailable() && isListerPlatform(platform);
  // US-2720: when this IS an extension channel and the send is not on offer, say
  // why. Rendering nothing is what made a paid feature look like a missing one.
  const unavailableReason = isListerPlatform(platform)
    ? listerUnavailableReason()
    : null;
  // A channel whose selectors nobody has re-verified degrades to the manual
  // message inside the extension anyway (MARKETPLACE_EXTENSION_FLOW), so say it
  // here instead of offering a send the background will refuse.
  const flowVerifying =
    isListerPlatform(platform) &&
    MARKETPLACE_EXTENSION_FLOW[platform] === "verifying";
  const sendExtension = async () => {
    if (!isListerPlatform(platform)) return; // narrows to a ListerPlatform
    if (errors.length > 0) {
      toast.error("Fix the blocking issues before sending to the extension.");
      return;
    }
    setSending(true);
    try {
      const payload = buildListerPayload({
        platform,
        itemId,
        // US-2736: the SAME resolved variant the panel is showing. Sending the
        // raw one would hand the extension an empty price while the seller is
        // looking at a filled-in Listing price row.
        variant: priced,
        photos,
        primaryId,
      });
      const res = await sendToLister(payload);
      if (res.needsConsent) {
        toast.error("Open the GradeThread Lister and accept its terms first.");
        return;
      }
      // US-2720: the seller gate is an active paid FlipDesk plan
      // (resolveSellerEntitlement in the edge). "Unauthorized" as a bare toast
      // reads as a bug; it is a plan, and a plan has a link.
      if (res.needsUpgrade) {
        setNeedsUpgrade(true);
        toast.error("Cross-listing needs an active paid FlipDesk plan.");
        return;
      }
      if (!res.ok && !res.filled) {
        toast.error(res.error ?? `Couldn't send to ${spec.label}.`);
        return;
      }
      // US-1877 (AC2): the tab was PREFILLED, not published — the seller still has
      // to review and hit Submit, and may never do it. Recording this as `active`
      // (which is what happened before) minted a phantom live cross-listing in
      // their inventory. published:false records a draft; it is promoted only when
      // the listing is confirmed live.
      const wb = await edgeFetch("/api/flipdesk/listings/extension-writeback", {
        method: "POST",
        json: {
          item_id: itemId,
          platform,
          listing_url: res.listingUrl ?? null,
          published: false,
        },
      });
      if (!wb.ok) {
        // US-2725: this used to print the server's sentence straight after our
        // own, so a real seller read "couldn't record the cross-listing: Could
        // not record the cross-listing" — the same words twice and no next step.
        // The form IS filled at this point, so the useful thing to say is that
        // the listing is fine and how to record it once they submit.
        const j = (await wb.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
        };
        const ref = j.code ?? String(wb.status);
        toast.error(
          `${spec.label} is prefilled, but FlipDesk couldn't record it (${ref}). ` +
            `Submit the listing, then press "I published it" to record it here.`,
          { duration: 12_000 },
        );
        setPrefilled(true);
        return;
      }
      // US-1877 (AC4): say what actually happened to the photos. This used to be a
      // binary, and photosAttached was true when ANY photo landed — so a 6-of-8
      // attach read as a clean success and the seller published a listing missing
      // two photos without ever being told.
      // 2026-08-11: the price gets the same treatment, and it is a WARNING
      // rather than a success line. On Poshmark the price input is not on the
      // create page at all — it lives in a dialog the seller opens later — so
      // the fill silently did nothing and this toast said "prefilled, review
      // and submit" over a listing with no price on it.
      // Both notes always compose — a run can miss the price AND drop photos,
      // and showing only the louder one would hide the other.
      const priceMsg = priceNote(res);
      const photoMsg = photoNote(res);
      if (priceMsg) {
        toast.warning(`${spec.label} prefilled in a new tab.${priceMsg}${photoMsg}`);
      } else {
        toast.success(
          `${spec.label} prefilled in a new tab — review and submit.` + photoMsg,
        );
      }
      // The seller now has a draft row they can promote once they've published —
      // see the "I published it" control below.
      setPrefilled(true);
      void qc.invalidateQueries({ queryKey: ["platform-fields", itemId] });
      void qc.invalidateQueries({ queryKey: ["item_listing_platforms"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send to extension failed.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-3">
      {(errors.length > 0 || warnings.length > 0) && (
        <div className="space-y-1 rounded-md border p-2 text-xs">
          {errors.map((i, idx) => (
            <div key={`e${idx}`} className="flex items-start gap-1.5 text-brand-red-text">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{i.message}</span>
            </div>
          ))}
          {warnings.map((i, idx) => (
            <div key={`w${idx}`} className="flex items-start gap-1.5 text-amber-600 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{i.message}</span>
            </div>
          ))}
        </div>
      )}

      {variant.categoryNeedsPick && (
        <div className="flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            We couldn’t confidently map this item to a {spec.label} category
            {variant.categorySource === "ai" ? " (AI best-guess shown)" : ""}. Pick the
            right category below before listing
            {variant.categoryDepartment
              ? ` — suggested department: ${variant.categoryDepartment}`
              : ""}
            .
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {ready ? (
          <Badge
            variant="outline"
            className="gap-1 border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
          >
            <Check className="h-3.5 w-3.5" />
            Ready to list
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="gap-1 border-brand-red/40 bg-brand-red/10 text-brand-red-text"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            {errors.length} to fix
          </Badge>
        )}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={copyAll}
          disabled={errors.length > 0}
          title={
            errors.length > 0
              ? "Fix the blocking issues before copying"
              : "Copy every field as a labeled block"
          }
        >
          <Copy className="mr-1.5 h-3.5 w-3.5" />
          Copy all fields
        </Button>
        {NEW_LISTING_URL[platform] && (
          <Button type="button" variant="outline" size="sm" asChild>
            <a href={NEW_LISTING_URL[platform]} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              Open {spec.label}
            </a>
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={photoCount === 0 || downloading}
          onClick={downloadPhotos}
          title={
            photoCount === 0
              ? "No photos on this item yet"
              : `Download the first ${inZip} photo${inZip === 1 ? "" : "s"} (cover first), ready to upload`
          }
        >
          {downloading ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="mr-1.5 h-3.5 w-3.5" />
          )}
          Download photos ({inZip})
        </Button>
        {/* US-716: the "Send to extension" control is shown only when the
            GradeThread Lister extension is configured (VITE_LISTER_EXTENSION=true
            + VITE_LISTER_EXTENSION_ID) AND this platform is one it automates
            (Poshmark/Mercari/Grailed). It prefills the marketplace's native form
            in the seller's own logged-in tab. */}
        {showSend && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={sending || errors.length > 0}
            onClick={sendExtension}
            title={
              errors.length > 0
                ? "Fix the blocking issues first"
                : `Prefill ${spec.label}'s listing form in a new tab`
            }
          >
            {sending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Puzzle className="mr-1.5 h-3.5 w-3.5" />
            )}
            Send to extension
          </Button>
        )}
        {/* US-1877 (AC2): promote the draft once the seller has actually
            published. Shown only after a prefill in this session — the automatic
            URL capture (AC1) handles the common case; this is the escape hatch for
            when that window is missed, so a real listing isn't stranded as a
            draft. */}
        {showSend && prefilled && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={confirming}
            onClick={confirmPublished}
            title={`Mark the ${spec.label} listing as live in FlipDesk`}
          >
            {confirming ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="mr-1.5 h-3.5 w-3.5" />
            )}
            I published it
          </Button>
        )}
      </div>

      {/* US-2720: the honest half of `showSend`. One of these renders whenever
          this is an extension channel and the send is not on offer — the manual
          controls above stay exactly as they are either way. */}
      {isListerPlatform(platform) && (unavailableReason || flowVerifying) && (
        <CrossPostNotice
          platform={platform}
          platformLabel={spec.label}
          itemId={itemId}
          reason={flowVerifying ? "verifying" : unavailableReason!}
        />
      )}
      {needsUpgrade && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Cross-listing needs an active paid FlipDesk plan.{" "}
            <Link to="/pricing" className="font-medium underline underline-offset-2">
              See plans
            </Link>
            .
          </span>
        </div>
      )}

      <div className="space-y-3">
        {spec.fields.map((f) => (
          <KitField
            key={f.key}
            field={f}
            value={valueOf(f)}
            editable={editableKeys.has(f.key)}
            onChange={(v) => setEdits((prev) => ({ ...prev, [f.key]: v }))}
          />
        ))}
      </div>
    </div>
  );
}

// US-2720: why cross-listing is not on offer for this channel right now.
//
// Three causes, three different next actions, and collapsing them is how a
// seller ends up believing the feature does not exist:
//
//   disabled      — this deployment never switched the bridge on. Nothing the
//                   seller does fixes it, so it does not send them anywhere.
//   not-installed — the one they CAN fix. Install, then sign in from the
//                   extension's own popup.
//   verifying     — the channel's selectors have not been re-checked against
//                   the live sell form, so the extension would report "list
//                   manually" anyway. Say it before the click, not after.
//
// Deliberately NOT a colored side-tab card: this sits directly above the field
// list and a 4px accent rail here reads as an error state on a form that is
// perfectly fine.
export function CrossPostNotice({
  platform,
  platformLabel,
  itemId,
  reason,
}: {
  platform: MarketplacePlatform;
  platformLabel: string;
  itemId: string;
  reason: "disabled" | "not-installed" | "verifying";
}) {
  const storeUrl = extensionWebStoreUrl();
  // US-2722: this browser cannot run the job. Another one might.
  const enqueue = useEnqueueExtensionWork();
  const [queued, setQueued] = useState(false);
  return (
    <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-2.5 text-xs text-muted-foreground">
      <Puzzle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="space-y-1">
        {reason === "verifying" && (
          <p>
            Automatic cross-listing to {platformLabel} is paused while we re-check
            its listing form. Use the fields below and post it yourself.
          </p>
        )}
        {reason === "disabled" && (
          <p>
            Automatic cross-listing to {platformLabel} is switched off for this
            site right now. The fields below are ready to copy in the meantime.
          </p>
        )}
        {reason === "not-installed" && (
          <>
            <p>
              <span className="font-medium text-foreground">
                Cross-listing needs the GradeThread extension.
              </span>{" "}
              It fills {platformLabel}&rsquo;s own listing form in your logged-in
              tab. Until it is installed, copy the fields below.
            </p>
            <p className="flex flex-wrap gap-x-3 gap-y-1">
              {storeUrl && (
                <a
                  href={storeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-foreground underline underline-offset-2"
                >
                  Get the extension
                </a>
              )}
              <Link
                to="/dashboard/flipdesk/marketplaces"
                className="font-medium text-foreground underline underline-offset-2"
              >
                Set up cross-posting
              </Link>
            </p>
            {/* US-2722: iOS has been able to hand this to the desktop since
                US-2481; the web could only queue DELISTS, so a seller on the
                machine without the extension had no option but copy-paste. The
                server holds an instruction — item, platform, locale — never a
                marketplace credential, and background.js drainQueue runs it the
                next time a browser that does have the extension wakes up. */}
            {queued ? (
              <p className="flex items-start gap-1.5 text-emerald-700 dark:text-emerald-300">
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>Queued for your desktop. {QUEUED_NOTICE}</span>
              </p>
            ) : (
              <div className="space-y-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={enqueue.isPending}
                  onClick={() => {
                    enqueue.mutate(
                      {
                        kind: "list",
                        platform,
                        inventoryItemId: itemId,
                        payload: {},
                      },
                      {
                        onSuccess: () => setQueued(true),
                        onError: (err) => toast.error(err.message),
                      },
                    );
                  }}
                >
                  {enqueue.isPending ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  Queue for my desktop
                </Button>
                {/* The sentence is shared verbatim across web, iOS, Android and
                    the edge. A queued job is not a listed job, and wording that
                    blurs the two is how a seller believes something is live. */}
                <p>{QUEUED_NOTICE}</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// US-1877 (AC4): what to tell the seller about the photos.
//
// The extension now reports { attached, failed, total } instead of a boolean that
// was true if ANY photo landed. A partial attach is the case that matters: the
// seller is about to publish, and "6 of 8" is the difference between them fixing it
// now and a buyer finding out later.
export function photoNote(res: {
  photosAttached?: boolean;
  photosTotal?: number;
  photosFailed?: number;
}): string {
  const total = res.photosTotal ?? 0;
  const failed = res.photosFailed ?? 0;
  // Nothing to attach (no file input, or no photos on the item) — not a problem to
  // report. Falls back to the old boolean for an extension that predates the counts.
  if (total === 0) return res.photosAttached ? "" : " Drag your downloaded photos in.";
  if (failed === 0) return "";
  const attached = total - failed;
  if (attached === 0) return " Photos didn't attach — drag your downloaded photos in.";
  return ` Attached ${attached} of ${total} photos — drag the rest in.`;
}

// 2026-08-11: what to tell the seller about the PRICE.
//
// Same idea as photoNote and a harder failure. A photo that did not attach is
// visible the moment the seller looks at the form; a price that was never set
// looks exactly like a price of zero or a blank field they assume was handled.
//
// `undefined` must stay silent. Extensions built before this field exists send
// no `priceFilled` at all, and treating "did not say" as "did not fill" would
// warn on every run of every older install — which trains the seller to ignore
// the one warning that means something.
export function priceNote(res: { priceFilled?: boolean }): string {
  return res.priceFilled === false
    ? " The price was NOT filled in — set it yourself before you post."
    : "";
}

export function ListingKit({ itemId, baseName }: { itemId: string; baseName?: string }) {
  const qc = useQueryClient();
  const gen = useGeneratePlatformFields();

  // The eBay draft row carries platform_fields + the cover photo id.
  const { data } = useQuery({
    queryKey: ["platform-fields", itemId],
    queryFn: async () => {
      const { data: row } = await supabase
        .from("listings")
        .select("id, platform_fields, primary_photo_id, listing_price")
        .eq("inventory_item_id", itemId)
        .eq("platform", "ebay")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return (row ?? null) as {
        id: string;
        platform_fields: Record<string, unknown> | null;
        primary_photo_id: string | null;
        listing_price: number | null;
      } | null;
    },
  });

  // Listing photos (RLS scopes to the owner) for the per-platform export.
  const { data: photos = [] } = useQuery({
    queryKey: ["item-photos-export", itemId],
    queryFn: async () => {
      const { data: rows } = await supabase
        .from("item_photos")
        .select("id, photo_url, photo_type, sort_order")
        .eq("inventory_item_id", itemId)
        .order("sort_order", { ascending: true });
      return (rows ?? []) as ExportablePhoto[];
    },
  });
  const primaryId = data?.primary_photo_id ?? null;

  // US-2736: the price the kit falls back to when the stored variant has none.
  //
  // A variant's price is written once, when it is generated. Every draft
  // generated before the server-side fix carries 0, and 0 renders as a blank
  // Listing price and reaches the extension as "" — which it refuses to type.
  // Fixing only the generator would have meant every existing draft stayed
  // broken until someone thought to press Regenerate.
  //
  // Resolving it at RENDER time fixes them all at once, with no regeneration
  // and no deploy ordering to get right. Same precedence as the generator and
  // the extension writeback: the eBay draft's price, else the item's target.
  const { data: itemPrice } = useQuery({
    queryKey: ["item-target-price", itemId],
    queryFn: async () => {
      const { data: row } = await supabase
        .from("inventory_items")
        .select("target_price")
        .eq("id", itemId)
        .maybeSingle();
      return (row as { target_price: number | null } | null)?.target_price ?? null;
    },
  });
  const fallbackPrice =
    (data?.listing_price && data.listing_price > 0 ? data.listing_price : null) ??
    (itemPrice && itemPrice > 0 ? itemPrice : 0);

  // Seed from persisted platform_fields; overlay anything just generated.
  const variants = useMemo(() => {
    const map: Record<string, PlatformKitVariant> = {};
    const stored = (data?.platform_fields ?? {}) as Record<string, Record<string, unknown>>;
    for (const [plat, raw] of Object.entries(stored)) {
      map[plat] = normalize(plat, raw);
    }
    for (const v of gen.data?.variants ?? []) {
      map[v.platform] = v;
    }
    return map;
  }, [data?.platform_fields, gen.data]);

  const hasAny = Object.keys(variants).length > 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>Cross-list copy kit</CardTitle>
            <CardDescription>
              AI-tailored fields for marketplaces without API push — copy each field
              into Poshmark, Mercari, Depop, or Grailed.
            </CardDescription>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              gen.mutate(
                { itemId, platforms: KIT_PLATFORMS },
                {
                  onSuccess: () => {
                    toast.success("Marketplace fields generated");
                    void qc.invalidateQueries({ queryKey: ["platform-fields", itemId] });
                  },
                },
              );
            }}
            disabled={gen.isPending}
          >
            <Wand2 className="mr-1.5 h-4 w-4" />
            {gen.isPending
              ? "Generating…"
              : hasAny
                ? "Regenerate"
                : "Generate for all marketplaces"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue={KIT_PLATFORMS[0]}>
          <TabsList className="flex-wrap">
            {KIT_PLATFORMS.map((p) => {
              const spec = getMarketplaceSpec(p);
              const v = variants[p];
              const hasErr = v ? !v.validation?.ok : false;
              return (
                <TabsTrigger key={p} value={p} className="gap-1.5">
                  {spec?.label ?? p}
                  {hasErr && <span className="h-1.5 w-1.5 rounded-full bg-brand-red" />}
                </TabsTrigger>
              );
            })}
          </TabsList>
          {KIT_PLATFORMS.map((p) => (
            <TabsContent key={p} value={p} className="mt-4">
              {getMarketplaceSpec(p)?.pushMechanism === "manual" || p === "depop" ? (
                <div className="mb-3">
                  <Badge variant="outline" className="text-[11px]">
                    {p === "depop" ? "API pending — copy-paste for now" : "No API — copy-paste / extension"}
                  </Badge>
                </div>
              ) : null}
              <PlatformPanel
                platform={p}
                variant={variants[p]}
                fallbackPrice={fallbackPrice}
                photos={photos}
                primaryId={primaryId}
                baseName={baseName ?? `item-${itemId.slice(0, 8)}`}
                itemId={itemId}
              />
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}

// Normalizes a persisted platform_fields entry (no `platform` key) into the
// PlatformKitVariant shape the panel renders.
function normalize(platform: string, raw: Record<string, unknown>): PlatformKitVariant {
  const cond = raw.condition as { value?: string; label?: string } | null | undefined;
  const validation = (raw.validation ?? { platform, ok: true, issues: [] }) as
    PlatformKitVariant["validation"];
  return {
    platform,
    title: typeof raw.title === "string" ? raw.title : "",
    description: typeof raw.description === "string" ? raw.description : "",
    condition: cond && cond.value ? { value: cond.value, label: cond.label ?? cond.value } : null,
    category: typeof raw.category === "string" ? raw.category : "",
    categorySource: (raw.category_source as PlatformKitVariant["categorySource"]) ?? null,
    categoryDepartment: (raw.category_department as string | null) ?? null,
    categoryNeedsPick: raw.category_needs_pick === true,
    brand: (raw.brand as string | null) ?? null,
    color: (raw.color as string | null) ?? null,
    size: (raw.size as string | null) ?? null,
    price: typeof raw.price === "number" ? raw.price : 0,
    tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : [],
    confidence: typeof raw.confidence === "number" ? raw.confidence : 0,
    validation,
  };
}
