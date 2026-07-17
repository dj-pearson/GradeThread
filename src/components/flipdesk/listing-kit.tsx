import { useMemo, useState } from "react";
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
  isListerAvailable,
  isListerPlatform,
  sendToLister,
} from "@/lib/lister-extension";
import { edgeFetch } from "@/lib/edge-fetch";

// Copy-paste targets: the no-API platforms (Poshmark/Mercari/Grailed) plus
// Depop until its partner API is live (US-712/713/714). Shopify + eBay push via
// their adapters, so they're not copy-paste targets.
const KIT_PLATFORMS: MarketplacePlatform[] = [
  "poshmark",
  "mercari",
  "depop",
  "grailed",
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
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="min-h-[88px] text-sm"
        />
      ) : editable ? (
        <Input value={value} onChange={(e) => onChange(e.target.value)} className="text-sm" />
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
  photos,
  primaryId,
  baseName,
  itemId,
}: {
  platform: MarketplacePlatform;
  variant: PlatformKitVariant | undefined;
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
  const valueOf = (f: FieldSpec) =>
    edits[f.key] ?? fieldValue(f.key, variant);

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
  const sendExtension = async () => {
    if (!isListerPlatform(platform)) return; // narrows to a ListerPlatform
    if (errors.length > 0) {
      toast.error("Fix the blocking issues before sending to the extension.");
      return;
    }
    setSending(true);
    try {
      const payload = buildListerPayload({ platform, itemId, variant, photos, primaryId });
      const res = await sendToLister(payload);
      if (res.needsConsent) {
        toast.error("Open the GradeThread Lister and accept its terms first.");
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
        const j = await wb.json().catch(() => ({}));
        toast.error(
          `Prefilled ${spec.label}, but couldn't record the cross-listing: ${
            j.error ?? wb.status
          }`,
        );
        return;
      }
      // US-1877 (AC4): say what actually happened to the photos. This used to be a
      // binary, and photosAttached was true when ANY photo landed — so a 6-of-8
      // attach read as a clean success and the seller published a listing missing
      // two photos without ever being told.
      toast.success(
        `${spec.label} prefilled in a new tab — review and submit.` +
          photoNote(res),
      );
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

export function ListingKit({ itemId, baseName }: { itemId: string; baseName?: string }) {
  const qc = useQueryClient();
  const gen = useGeneratePlatformFields();

  // The eBay draft row carries platform_fields + the cover photo id.
  const { data } = useQuery({
    queryKey: ["platform-fields", itemId],
    queryFn: async () => {
      const { data: row } = await supabase
        .from("listings")
        .select("id, platform_fields, primary_photo_id")
        .eq("inventory_item_id", itemId)
        .eq("platform", "ebay")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return (row ?? null) as {
        id: string;
        platform_fields: Record<string, unknown> | null;
        primary_photo_id: string | null;
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
