import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import {
  AlertTriangle,
  Check,
  Clock,
  Copy,
  Download,
  ExternalLink,
  HelpCircle,
  Loader2,
  Puzzle,
  Send,
  Wand2,
  XCircle,
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
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/lib/supabase";
import { stepPrice } from "@/lib/marketplace-price";
import {
  type ResolvedSiblingPrice,
  resolveSiblingPrice,
} from "@/lib/cross-listing-price";
import { cn } from "@/lib/utils";
import {
  charStatus,
  type DraftFields,
  type FieldIssue,
  getMarketplaceSpec,
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
  listerBlockCause,
  type ListerBlockCause,
  type ListerResult,
  onListerListed,
  photoWitnessState,
  requestDrainNow,
  sendToLister,
} from "@/lib/lister-extension";
import {
  type CrossListingPlatform,
  MARKETPLACE_EXTENSION_FLOW,
  MARKETPLACE_LABELS,
} from "@/lib/constants";
import type { ListingPlatform } from "@/types/database";
import {
  type ChannelStatus,
  deriveChannelState,
  planListEverywhere,
} from "@/lib/channel-state";
import { useItemListings } from "@/hooks/use-item-listings";
import { useCrossPush } from "@/hooks/use-cross-listing";
import { useEndListing, useNotListed } from "@/hooks/use-listing-lifecycle";
import { useMarkDelistDone } from "@/hooks/use-pending-delists";
import { useCrossPostChannels } from "@/hooks/use-cross-post-channels";
import {
  type ChannelOverrides,
  readChannelOverrides,
  resolveChannelTitle,
} from "@/lib/channel-copy";
import { kitPlatformsFor } from "@/lib/kit-platforms";
import { edgeFetch } from "@/lib/edge-fetch";
import {
  QUEUED_NOTICE,
  useCancelExtensionWork,
  useEnqueueExtensionWork,
  useExtensionQueue,
} from "@/hooks/use-extension-queue";
import { useListerLocales } from "@/hooks/use-lister-locales";
import { ActiveListingsLinks } from "@/components/flipdesk/delist-panel";
import { localeForPlatform } from "@/lib/lister-locales";

// The kit's channel list lives in src/lib/kit-platforms.ts (US-3046), shared
// with the drafts page's bulk fill so the two cannot disagree.
// Where to send the seller to create the listing manually.
const NEW_LISTING_URL: Partial<Record<MarketplacePlatform, string>> = {
  poshmark: "https://poshmark.com/create-listing",
  mercari: "https://www.mercari.com/sell/",
  depop: "https://www.depop.com/sell/",
  grailed: "https://www.grailed.com/sell/",
  // 2026-09-02. Vinted joined the kit on 2026-08-11 with no entry here, so its
  // tab was the only one without an "Open" button.
  vinted: "https://www.vinted.com/items/new",
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
    // Depop's style field. It fell through to "" on every kit until 2026-09-02;
    // the server now carries the eBay Style specific for it.
    case "style":
      return v.style ?? "";
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
  /** Fired when an editable field loses focus: where a typed change is saved. */
  onBlur?: () => void;
  /** A line under the field, e.g. that this channel no longer copies eBay. */
  footer?: ReactNode;
}

function KitField({ field, value, editable, onChange, onBlur, footer }: KitFieldProps) {
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
          onBlur={onBlur}
          className="min-h-[88px] text-sm"
        />
      ) : editable ? (
        <Input
          aria-label={field.label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          className="text-sm"
        />
      ) : (
        <div className="whitespace-pre-wrap rounded-md border bg-muted/40 px-3 py-2 text-sm">
          {value || <span className="text-muted-foreground">—</span>}
        </div>
      )}
      {footer}
    </div>
  );
}

/** The item's own facts, which beat the kit variant's snapshot of them. */
export interface KitItemFacts {
  title: string | null;
  brand: string | null;
  color: string | null;
  size: string | null;
}

/** The free-text fields a seller can give their own words per channel. */
type CopyKey = "title" | "description";
const isCopyKey = (key: string): key is CopyKey =>
  key === "title" || key === "description";

function PlatformPanel({
  platform,
  variant,
  channelPrice,
  fallbackPrice,
  photos,
  primaryId,
  baseName,
  itemId,
  liveDescription,
  listingId,
  sharedTitle,
  itemFacts,
  overrides,
  status,
}: {
  platform: MarketplacePlatform;
  variant: PlatformKitVariant | undefined;
  /** US-3367: what this item is doing on this channel right now. */
  status: ChannelStatus;
  /** The eBay draft's id: where this channel's own words are saved. */
  listingId: string | null;
  /** The eBay title. Every channel copies it unless `overrides.title` is set. */
  sharedTitle: string | null;
  /** The item's current facts. Null until the read lands. */
  itemFacts: KitItemFacts | null;
  /** The seller's own words for this channel (channel-copy.ts). */
  overrides: ChannelOverrides;
  /**
   * US-3317: what THIS channel costs, off its own sibling `listings` row.
   * Null when the channel has no row yet, which is the only case the shared
   * price is used for.
   */
  channelPrice: number | null;
  /** US-2736: used when the stored variant carries no price. 0 means none. */
  fallbackPrice: number;
  photos: ExportablePhoto[];
  primaryId: string | null;
  baseName: string;
  itemId: string;
  /**
   * This platform's description rendered by the edge (platform-description.ts):
   * eBay's words and the item's current facts, or the seller's own words for
   * this channel when they typed some. Undefined until the query lands, and
   * null when the listing has no blocks to render. The caller passes
   * `|| undefined` rather than `?? undefined`: an empty render means there was
   * nothing to render, and blanking the field the seller is about to cross-post
   * is worse than showing the words already stored.
   */
  liveDescription?: string | null;
}) {
  const qc = useQueryClient();
  const spec = getMarketplaceSpec(platform);
  // Local edits to the free-text fields, keyed by field key. A title or
  // description edit is saved as this channel's own words when the field loses
  // focus, and the local copy is dropped once the saved one is back.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [downloading, setDownloading] = useState(false);
  const [sending, setSending] = useState(false);
  // US-1877 (AC2): a prefill records a DRAFT. This surfaces the control that
  // promotes it once the seller has actually hit Submit on the marketplace.
  const [prefilled, setPrefilled] = useState(false);
  // US-2738: the fill result the witness line reads. Kept as the whole result
  // rather than a derived word, so the line answers from the same fields the
  // toast did and the two can never disagree.
  const [lastFill, setLastFill] = useState<ListerResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  // US-2720: set only by an explicit refusal FROM the extension — never
  // inferred from the plan we think the account is on, because the extension is
  // the thing enforcing it.
  //
  // US-3295: a REASON now, not a boolean. The extension refuses a send whenever
  // `caps.lister` is false, and that is false for two unrelated reasons: the
  // install has no account token at all, or it has one and the account is on
  // Free. Older builds report both as `needsUpgrade`, so a Business seller whose
  // extension had simply never been connected was told to buy a plan they were
  // already paying for, under a link to /pricing. Which one it is comes from the
  // extension too — the same GT_PING the Marketplaces setup card reads.
  //
  // US-3296: a THIRD reason, and the one that had been silently breaking every
  // connected seller. The token lasts 30 days and nothing renewed it, so an
  // install that connected in March was anonymous by May — indistinguishable,
  // from here, from one that never connected. "Reconnect" is its own answer.
  const [blockedBy, setBlockedBy] = useState<ListerBlockCause | null>(null);
  // US-2777: the seller's country domain per platform, for the DIRECT send.
  // Read here rather than at the send, because a query cannot be started inside
  // a click handler and a send that had to wait for it would be a send that
  // sometimes went to the wrong country.
  const { data: listerLocales } = useListerLocales();
  // US-3369: this channel's own row, newest first, for the "Live on X" line.
  // The same cached read the item page's other panels share.
  const { data: itemListingRows = [] } = useItemListings(itemId);
  const channelRow = itemListingRows.find((r) => r.platform === platform) ?? null;
  // US-3367: the verbs the status row offers. Each one is the existing hook
  // the Listings page or the delist banner already uses; nothing new is wired.
  const endListing = useEndListing();
  const cancelJob = useCancelExtensionWork();
  const markDone = useMarkDelistDone();
  const enqueueRetry = useEnqueueExtensionWork();
  // US-3367: the opt-out. A filled form is recorded as listed until the seller
  // says otherwise; this is the "otherwise".
  const notListed = useNotListed();

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
          setLastFill(null);
          toast.success(`${spec?.label ?? platform} listing is live — recorded in FlipDesk.`);
          void qc.invalidateQueries({ queryKey: ["platform-fields", itemId] });
          void qc.invalidateQueries({ queryKey: ["item_listing_platforms"] });
          void qc.invalidateQueries({ queryKey: ["item_listings", itemId] });
          // The composer's own views of the item. A confirmed cross-post flips
          // the item to `listed`, and leaving these stale is why the status
          // chip beside the editor kept saying "drafted" after the toast said
          // the opposite.
          void qc.invalidateQueries({ queryKey: ["items_full"] });
          void qc.invalidateQueries({ queryKey: ["inventory_item_ebay", itemId] });
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
      toastError(err, "Couldn't export photos.");
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
      setLastFill(null);
      void qc.invalidateQueries({ queryKey: ["platform-fields", itemId] });
      void qc.invalidateQueries({ queryKey: ["item_listing_platforms"] });
      void qc.invalidateQueries({ queryKey: ["item_listings", itemId] });
      void qc.invalidateQueries({ queryKey: ["items_full"] });
      void qc.invalidateQueries({ queryKey: ["inventory_item_ebay", itemId] });
    } catch (err) {
      toastError(err, "Couldn't record the listing.");
    } finally {
      setConfirming(false);
    }
  };

  if (!variant) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Not generated yet. New drafts fill this on their own for the channels
        you chose under Marketplaces; for this one, click “Generate for all
        marketplaces” above.
      </p>
    );
  }

  // title/description + the platform category are editable (the seller confirms
  // the seeded category / department — US-722); the rest is copy-only display.
  // The spec's own labels, so this list can never drift from the rows below it.
  const manualFieldLabels = (spec.manualFields ?? [])
    .map((key) => spec.fields.find((f) => f.key === key)?.label)
    .filter((label): label is string => Boolean(label));

  // US-3317: price is NOT editable here, and that is a decision rather than an
  // omission — see resolveKitPrice. The desk reads this channel's recorded
  // price; it does not mint a new one, because a number typed into a panel that
  // writes nothing back is undone by the next read.
  const editableKeys = new Set(["title", "description", "category", "department"]);
  // US-2736: one resolved variant, so the DISPLAYED price, the validation that
  // decides "Ready to list", and the payload the extension receives can never
  // disagree about what this item costs. Patching only the render would have
  // shown a price the extension still refused to type.
  //
  // US-3317: and one RULE, shared with the cross-push and the queue, so the
  // three of them cannot hold three opinions about what this channel charges.
  // The step (Poshmark and Vinted price in whole dollars, and their inputs are
  // pattern="[0-9]*") is applied inside it, to nearest rather than floored —
  // flooring quietly costs the seller money on every cross-post, and the number
  // is shown in the row below before they send it.
  const steppedPrice = resolveKitPrice(platform, {
    channelPrice,
    variantPrice: variant.price,
    fallbackPrice,
  }).price;
  // 2026-09-11 (channel-copy.ts): every channel copies eBay. The variant's
  // title, description and colour were written once, when the kit ran, so an
  // item drafted "Gray" and corrected to "Navy Blue" on eBay kept saying Gray
  // here and the seller retyped the fix into every tab. Now:
  //   - the title is the eBay title fitted to this channel, unless the seller
  //     saved their own for it;
  //   - the description is the edge's render (eBay's words, current facts, or
  //     the seller's own), and the stored variant is only a fallback while that
  //     render is in flight;
  //   - brand, colour and size come from the item.
  // One resolved variant, for the same reason as the stepped price: what the
  // panel shows and what the extension types must be the one thing.
  const ebayTitle = resolveChannelTitle(platform, {
    sharedTitle,
    itemTitle: itemFacts?.title,
  });
  const resolvedTitle = resolveChannelTitle(platform, {
    override: overrides.title,
    sharedTitle,
    itemTitle: itemFacts?.title,
  });
  const resolvedDescription =
    liveDescription ?? overrides.description ?? variant.description;
  const priced: PlatformKitVariant = {
    ...variant,
    price: steppedPrice,
    title: resolvedTitle,
    description: resolvedDescription,
    brand: itemFacts?.brand || variant.brand,
    color: itemFacts?.color || variant.color,
    size: itemFacts?.size || variant.size,
  };
  const valueOf = (f: FieldSpec) =>
    edits[f.key] ?? fieldValue(f.key, priced);

  // Save (or clear) this channel's own words. `null` means "copy eBay again".
  const saveChannelCopy = async (key: CopyKey, value: string | null) => {
    if (!listingId) return;
    try {
      const res = await edgeFetch(
        `/api/flipdesk/description/${listingId}/channel-copy`,
        { method: "POST", json: { platform, [key]: value } },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(j.error ?? `Couldn't save the ${spec.label} ${key}.`);
        return;
      }
      await qc.invalidateQueries({ queryKey: ["platform-fields", itemId] });
      await qc.invalidateQueries({ queryKey: ["platform-descriptions"] });
      setEdits((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      toast.success(
        value == null
          ? `${spec.label} ${key} copies eBay again.`
          : `${spec.label} ${key} saved. eBay edits won't change it.`,
      );
    } catch (err) {
      toastError(err, `Couldn't save the ${spec.label} ${key}.`);
    }
  };

  // A typed title or description becomes this channel's own words when the
  // field loses focus. Typing it back to eBay's, or clearing it, goes back to
  // copying eBay.
  //
  // A no-op blur still drops the local copy: a leftover edit equal to today's
  // title would otherwise shadow tomorrow's eBay correction on this tab.
  const onCopyBlur = (key: CopyKey) => {
    const typed = edits[key];
    if (typed === undefined) return;
    const shown = key === "title" ? resolvedTitle : resolvedDescription;
    const ebayValue = key === "title"
      ? ebayTitle
      : overrides.description == null ? liveDescription : undefined;
    const next = typed.trim() === "" || typed === ebayValue ? null : typed;
    if (typed === shown || next === overrides[key]) {
      setEdits((prev) => {
        const rest = { ...prev };
        delete rest[key];
        return rest;
      });
      return;
    }
    void saveChannelCopy(key, next);
  };

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
    // US-2738: a new send's photos have not been witnessed yet, so the previous
    // run's line must not sit there implying they have.
    setLastFill(null);
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
        // US-2777: the seller's country domain for this platform. Undefined for
        // everyone who has not picked one, which is the platform default and
        // therefore exactly today's behaviour. The QUEUED path does NOT read
        // this — the edge stamps it at enqueue time, so the phone clients get
        // it without three copies of the lookup.
        locale: localeForPlatform(listerLocales, platform),
      });
      const res = await sendToLister(payload);
      if (res.needsConsent) {
        toast.error("Open the GradeThread Lister and accept its terms first.");
        return;
      }
      // US-2720/US-3295: the seller gate is an active paid FlipDesk plan
      // (resolveSellerEntitlement in the edge) AND a connected install.
      // "Unauthorized" as a bare toast reads as a bug; each of these is a step,
      // and each step has its own link.
      if (res.needsUpgrade || res.needsSignIn) {
        const cause = await listerBlockCause(res);
        setBlockedBy(cause);
        toast.error(
          cause === "reconnect"
            // US-3296: the connection lasted 30 days and nothing renewed it, so
            // this seller connected once and was dropped without being told.
            ? "Your GradeThread connection expired. Reconnect the extension."
            : cause === "signin"
            ? "The extension is not connected to your GradeThread account yet."
            : "Cross-listing needs an active paid FlipDesk plan.",
        );
        return;
      }
      if (!res.ok && !res.filled) {
        toast.error(res.error ?? `Couldn't send to ${spec.label}.`);
        return;
      }
      // US-2738: keep the photo witness BEFORE the writeback, because whether
      // the photos reached the marketplace has nothing to do with whether we
      // managed to record the cross-listing here. The writeback has its own
      // failure path below that returns early, and losing the witness down it
      // would drop the message on exactly the run that already went wrong once.
      setLastFill(res);
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
      // US-2730: brand and tags compose in too. A run can miss the price, drop
      // photos AND fail the brand; showing only the loudest hides the rest.
      const brandMsg = brandNote(res);
      const tagsMsg = tagsNote(res);
      const problems = `${priceMsg}${photoMsg}${brandMsg}${tagsMsg}`;
      if (problems) {
        toast.warning(`${spec.label} prefilled in a new tab.${problems}`);
      } else {
        toast.success(`${spec.label} prefilled in a new tab — review and submit.`);
      }
      // The seller now has a draft row they can promote once they've published —
      // see the "I published it" control below.
      setPrefilled(true);
      void qc.invalidateQueries({ queryKey: ["platform-fields", itemId] });
      void qc.invalidateQueries({ queryKey: ["item_listing_platforms"] });
      void qc.invalidateQueries({ queryKey: ["item_listings", itemId] });
    } catch (err) {
      toastError(err, "Send to extension failed.");
    } finally {
      setSending(false);
    }
  };

  const label = spec.label;
  const when = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString() : "";

  return (
    <div className="space-y-3">
      {/* US-3367: what this channel is doing, and the one verb that applies.
          Rendered above everything else because it is the answer to "did it
          go up" and "where is it", which used to have no answer at all. */}
      {status.state !== "none" && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs">
          <span>
            {status.state === "live" && (
              <>Live on {label}{status.since ? ` since ${when(status.since)}` : ""}.</>
            )}
            {status.state === "unconfirmed" && (
              <>
                Recorded as listed on {label}: the form was filled
                {status.since ? ` ${when(status.since)}` : ""}, but nothing saw it go
                live. Not listed after all? Say so, or confirm it.
              </>
            )}
            {status.state === "queued" && (
              <>Queued for your desktop. Nothing is live on {label} yet.</>
            )}
            {status.state === "delist_queued" && (
              <>Ending on {label} from your browser. It is live there until then.</>
            )}
            {status.state === "prefilled" && (
              <>The {label} form was filled but never confirmed live.</>
            )}
            {status.state === "failed" && (
              <>{status.queueItem?.result?.error ?? `The last ${label} run did not finish.`}</>
            )}
            {status.state === "ended" && <>Ended on {label}.</>}
            {status.state === "sold" && <>Sold on {label}.</>}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            {status.url && (
              <Button type="button" variant="outline" size="sm" className="h-7" asChild>
                <a href={status.url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-1 h-3.5 w-3.5" />
                  View on {label}
                </a>
              </Button>
            )}
            {status.state === "live" && status.row && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7"
                disabled={endListing.isPending}
                aria-label={`End the ${label} listing`}
                onClick={() =>
                  endListing.mutate(
                    { listingId: status.row!.id },
                    {
                      onSuccess: (r) => {
                        // Deliberately not "ended" for a queued end: the
                        // listing is live until the browser runs the job.
                        if (r.queued) {
                          toast.info(`Ending on ${label} from your browser. ${QUEUED_NOTICE}`);
                          void requestDrainNow();
                        } else {
                          toast.success(`Ended on ${label}.`);
                        }
                      },
                      onError: (e) => toastError(e, "Could not end the listing."),
                    },
                  )}
              >
                {endListing.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "End listing"}
              </Button>
            )}
            {(status.state === "unconfirmed" || status.state === "live") &&
              status.row && isListerPlatform(platform) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                disabled={notListed.isPending}
                aria-label={`Mark the ${label} listing as not listed`}
                title={`FlipDesk recorded this as listed on ${label}. Press if it is not.`}
                onClick={() =>
                  notListed.mutate(
                    { listingId: status.row!.id, itemId },
                    {
                      onSuccess: () => toast.success(`Recorded as not listed on ${label}.`),
                      onError: (e) => toastError(e, "Could not update the listing."),
                    },
                  )}
              >
                Not listed
              </Button>
            )}
            {status.state === "unconfirmed" && showSend && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-7"
                disabled={confirming}
                aria-label={`Confirm the ${label} listing is live`}
                onClick={confirmPublished}
              >
                Yes, it is listed
              </Button>
            )}
            {/* Cancel only while queued (US-3048): a claimed row is mid-fill in a
                marketplace tab and pulling it leaves that tab half done. */}
            {status.state === "queued" && status.queueItem?.status === "queued" && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                disabled={cancelJob.isPending}
                aria-label={`Cancel the queued ${label} cross-post`}
                onClick={() =>
                  cancelJob.mutate(status.queueItem!.id, {
                    onError: (e) => toastError(e, "Could not cancel that job."),
                  })}
              >
                Cancel
              </Button>
            )}
            {status.state === "delist_queued" && status.row && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                disabled={markDone.isPending}
                aria-label={`Mark the ${label} listing ended in FlipDesk`}
                onClick={() =>
                  markDone.mutate(status.row!.id, {
                    onError: (e) => toastError(e, "Could not update the queue."),
                  })}
              >
                Mark ended
              </Button>
            )}
            {status.state === "failed" && isListerPlatform(platform) && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7"
                disabled={enqueueRetry.isPending}
                aria-label={`Queue the ${label} cross-post again`}
                onClick={() =>
                  enqueueRetry.mutate(
                    {
                      kind: "list",
                      platform,
                      inventoryItemId: itemId,
                      listingId: status.row?.id ?? null,
                      payload: {},
                    },
                    {
                      onSuccess: () => {
                        toast.success(`Queued again. ${QUEUED_NOTICE}`);
                        void requestDrainNow();
                      },
                      onError: (e) => toastError(e, "Could not queue that."),
                    },
                  )}
              >
                Retry
              </Button>
            )}
            {status.state === "prefilled" && showSend && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="h-7"
                disabled={confirming}
                aria-label={`Mark the ${label} listing as live in FlipDesk`}
                onClick={confirmPublished}
              >
                I published it
              </Button>
            )}
          </span>
        </div>
      )}

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
                : `Fill ${spec.label}'s listing form in a new tab, right now`
            }
          >
            {sending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Puzzle className="mr-1.5 h-3.5 w-3.5" />
            )}
            {/* US-3367: renamed from "Send to extension" so it reads as a
                different verb from "List everywhere" above the tabs: this
                one fills THIS channel's form now, in a tab you watch. */}
            Fill {spec.label} now
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

      {/* US-3369: once it is live here, the way back to it. The listing itself
          when the capture found its link, and always this marketplace's own
          list of your active listings, so a seller can check it or end it by
          hand whatever the extension does. */}
      {channelRow?.listing_status === "active" && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            Live on {spec.label}.
          </span>
          <ActiveListingsLinks platform={platform} listingUrl={channelRow.listing_url} />
        </div>
      )}

      {/* US-2738: what happened to the photos, kept on screen next to the
          button that records the listing as live. The toast is gone by then and
          on a queue drain nobody read it. */}
      {lastFill && <PhotoWitnessLine res={lastFill} platformLabel={spec.label} />}

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
      {blockedBy && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {blockedBy === "reconnect"
            ? (
              <span>
                Your GradeThread connection expired, so the extension cannot tell
                which account to list for. Nothing is wrong with your plan.{" "}
                <Link
                  to="/connect-extension"
                  className="font-medium underline underline-offset-2"
                >
                  Reconnect the extension
                </Link>
                .
              </span>
            )
            : blockedBy === "signin"
            ? (
              <span>
                The extension is installed but not connected to your GradeThread
                account, so it cannot tell which account to list for.{" "}
                <Link
                  to="/connect-extension"
                  className="font-medium underline underline-offset-2"
                >
                  Connect the extension
                </Link>
                .
              </span>
            )
            : (
              <span>
                Cross-listing needs an active paid FlipDesk plan.{" "}
                <Link to="/pricing" className="font-medium underline underline-offset-2">
                  See plans
                </Link>
                .
              </span>
            )}
        </div>
      )}

      {/* US-2745: what the seller still has to set themselves, named up front.
          Only rendered where manualFields has been VERIFIED on the live form —
          an unset value means "not established", so the tab says nothing rather
          than promising the extension fills everything. */}
      {manualFieldLabels.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-2.5 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <span className="font-medium text-foreground">
              You&rsquo;ll set these on {spec.label} yourself:
            </span>{" "}
            {manualFieldLabels.join(", ")}. They are option lists whose choices
            change per garment, so GradeThread leaves them for you rather than
            guessing.
          </span>
        </div>
      )}

      <div className="space-y-3">
        {spec.fields.map((f) => {
          const copyKey = isCopyKey(f.key) ? f.key : null;
          const own = copyKey != null && overrides[copyKey] != null;
          return (
            <KitField
              key={f.key}
              field={f}
              value={valueOf(f)}
              editable={editableKeys.has(f.key)}
              onChange={(v) => setEdits((prev) => ({ ...prev, [f.key]: v }))}
              onBlur={copyKey && listingId ? () => onCopyBlur(copyKey) : undefined}
              footer={copyKey && listingId ? (
                <p className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                  {own
                    ? `Your own ${copyKey} for ${spec.label}. eBay edits won't change it.`
                    : `Copies your eBay ${copyKey}. Type here to use different words on ${spec.label} only.`}
                  {own && (
                    <button
                      type="button"
                      className="font-medium text-foreground underline underline-offset-2"
                      onClick={() => void saveChannelCopy(copyKey, null)}
                    >
                      Use eBay {copyKey}
                    </button>
                  )}
                </p>
              ) : null}
            />
          );
        })}
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
                        onError: (err) => toastError(err),
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
  photosUnverified?: number;
  /** US-2738: "page" | "none" | "not-asked", absent on an older run. */
  photosWitness?: string | null;
}): string {
  const total = res.photosTotal ?? 0;
  const failed = res.photosFailed ?? 0;
  // Nothing to attach (no file input, or no photos on the item) — not a problem to
  // report. Falls back to the old boolean for an extension that predates the counts.
  if (total === 0) return res.photosAttached ? "" : " Drag your downloaded photos in.";
  const attached = total - failed;
  // US-2738: where the PAGE answered, its answer outranks our own counting.
  //
  // "none" is the uploader refusing: it accepted the file selection and then
  // rendered nothing out of the bytes, for six seconds. attachPhotos already
  // converts that to every photo failed, so the branches below would reach
  // "Photos didn't attach" and tell the seller to drag them in. Close, but it
  // buries the one fact that changes what they should do: a re-send hands the
  // same uploader the same list and gets the same nothing, so the way out is a
  // different mechanism and not another try.
  if (res.photosWitness === "none") {
    return (
      " The page took the photos and never showed them, so they are not on the" +
      " listing. Add them to the form yourself; sending again will not help."
    );
  }
  // US-2775: a third state, between attached and failed.
  //
  // The page took the list only through the shadow fallback, where the only
  // thing saying the photos landed is the extension reading back what it just
  // wrote. Claiming success there is how US-2738's silent false success came
  // back; claiming FAILURE would cry wolf on the hosts where the shadow works.
  // So: say what is actually known. Checked before the clean-run return, since
  // an unverified run has no failures either.
  const unverified = res.photosUnverified ?? 0;
  // US-2738: "page" settles what the shadow hedge is unsure about. The page
  // rendered a preview out of our bytes, so the uploader read the list however
  // it was set, and doubting it here would be a false alarm on the only channel
  // that can answer at all. The extension zeroes `unverified` in that case; this
  // is the belt to that pair of braces.
  if (unverified > 0 && failed === 0 && res.photosWitness !== "page") {
    return " We couldn't confirm the photos attached — check the form before you post.";
  }
  if (failed === 0) return "";
  if (attached === 0) return " Photos didn't attach — drag your downloaded photos in.";
  return ` Attached ${attached} of ${total} photos — drag the rest in.`;
}

// US-2738: the photo witness, on screen, after the tab is gone.
//
// The toast above is a few seconds long and a queue drain produces one per
// channel. This is the same fact kept where the seller is standing when they
// decide whether the cross-post worked: beside "I published it", the button
// that turns a prefilled form into a recorded live listing.
//
// THREE SENTENCES, and the third is the reason the component exists. "Refused"
// is a problem and reads as one. "Confirmed" says what was actually checked and
// no more. The witness is a boolean (some uploaders draw one carousel node for
// eight photos), so it proves the uploader read the list, not that every file is
// there. And "unknown" is the case that used to render as nothing at all, which
// a seller reads as fine: four of the seven channels declare no preview selector
// and an older install sends no witness at all, and neither of those is the page
// saying yes. Absence is not confirmation, so it gets words.
//
// Quiet on purpose except for the refusal. `not-asked` fires on every ordinary
// Mercari, Grailed, Vinted and Facebook run, so an amber alert there would train
// the seller to dismiss the bar that means something.
export function PhotoWitnessLine({
  res,
  platformLabel,
}: {
  res: ListerResult;
  platformLabel: string;
}) {
  const state = photoWitnessState(res);
  if (state === "nothing-to-attach") return null;

  if (state === "refused") {
    return (
      <p className="flex items-start gap-1.5 text-xs text-brand-red-text">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>
          {platformLabel} never showed the photos it was handed, so they are not on
          the listing. Add them to the form yourself before you post.
        </span>
      </p>
    );
  }

  if (state === "confirmed") {
    const shown = Math.max(0, (res.photosTotal ?? 0) - (res.photosFailed ?? 0));
    return (
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>
          {platformLabel} previewed the photos we sent, so its uploader took them.
          That check is not a count, so glance at all {shown} before you post.
        </span>
      </p>
    );
  }

  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <HelpCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>
        Nothing confirmed the photos reached {platformLabel}. We handed them over
        and this run recorded no answer either way, so check the form before you
        post.
      </span>
    </p>
  );
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


// US-2730 AC5: what to tell the seller about BRAND and TAGS.
//
// The story added the first two fields the Lister has ever filled beyond title
// and description, and made runFlow report each honestly -- brandFilled and
// tagsCommitted go into the result. Nothing read them. They were declared on
// ListerResult and consumed by no surface, so a brand that did not fill was
// exactly the silent no-op US-2477 exists to prevent, one field along.
//
// Same undefined rule as priceNote, for the same reason: an older extension
// sends neither field, and warning on every run of every older install trains
// the seller to ignore the warning that means something.
export function brandNote(res: { brandFilled?: boolean }): string {
  return res.brandFilled === false
    ? ' The brand was NOT filled in -- set it yourself before you post.'
    : '';
}

// Partial is the interesting case and the reason this is a count rather than a
// boolean. Poshmark caps tags at three; committing two of three is a real
// outcome that neither "worked" nor "failed" describes.
export function tagsNote(res: { tagsCommitted?: number; tagsTotal?: number }): string {
  const { tagsCommitted: done, tagsTotal: total } = res;
  if (done === undefined || total === undefined || total === 0) return '';
  if (done >= total) return '';
  return done === 0
    ? ` None of your ${total} tags were added -- add them yourself before you post.`
    : ` Only ${done} of ${total} tags were added -- check them before you post.`;
}

export function ListingKit({ itemId, baseName }: { itemId: string; baseName?: string }) {
  const qc = useQueryClient();
  const gen = useGeneratePlatformFields();

  // The eBay draft row carries platform_fields + the cover photo id. US-3317:
  // every OTHER platform's row is read alongside it, because what a channel
  // costs lives on that channel's own row and this component used to send the
  // eBay number to all of them. RLS scopes `listings` to the owner, so this is
  // the seller's own rows and nobody else's.
  const { data } = useQuery({
    queryKey: ["platform-fields", itemId],
    queryFn: async () => {
      const { data: rows } = await supabase
        .from("listings")
        // listing_title: the eBay title every channel copies (channel-copy.ts).
        .select("id, platform, platform_fields, primary_photo_id, listing_price, listing_title")
        .eq("inventory_item_id", itemId)
        .order("created_at", { ascending: false });
      return readKitListings((rows ?? []) as KitListingRow[]);
    },
  });
  const draft = data?.draft ?? null;

  // Listing photos (RLS scopes to the owner) for the per-platform export.
  const { data: photos = [] } = useQuery({
    queryKey: ["item-photos-export", itemId],
    queryFn: async () => {
      const { data: rows } = await supabase
        .from("item_photos")
        // photo_role is what tells the MeasureCard frame apart from a tape
        // close-up (US-2462); without it every 'measurement' photo reads as the
        // card and a deliberately published close-up would be dropped.
        .select("id, photo_url, photo_type, photo_role, sort_order")
        .eq("inventory_item_id", itemId)
        .order("sort_order", { ascending: true });
      return (rows ?? []) as ExportablePhoto[];
    },
  });
  const primaryId = draft?.primary_photo_id ?? null;

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
  // US-2721: only the channels this seller cross-posts to. Narrowing here
  // rather than at the tab render means generate() also stops spending AI calls
  // on marketplaces they never open.
  const { data: chosenChannels } = useCrossPostChannels();
  // Never renders an empty kit - see kitPlatformsFor for the fallback rule.
  const kitPlatforms = useMemo(() => kitPlatformsFor(chosenChannels), [chosenChannels]);

  // US-3367: what each channel is doing, from the item's listing rows and the
  // seller's queue. One derivation (channel-state.ts) feeds the tab markers,
  // the per-panel status row and the checklist below.
  const { data: listingRows = [] } = useItemListings(itemId);
  const { data: queue } = useExtensionQueue();
  const queueForItem = useMemo(
    () =>
      [...(queue?.pending ?? []), ...(queue?.needsAttention ?? [])]
        .filter((it) => it.inventory_item_id === itemId),
    [queue, itemId],
  );
  const statuses = useMemo(() => {
    const out: Record<string, ChannelStatus> = {};
    for (const p of kitPlatforms) out[p] = deriveChannelState(listingRows, queueForItem, p);
    return out;
  }, [kitPlatforms, listingRows, queueForItem]);

  // The channels the one button can queue. Depop has no form-filler (its API
  // is pending) and a `verifying` flow would only report "list manually", so
  // neither is offered here; their tabs stay as copy kits.
  const queueable = useMemo(
    () =>
      kitPlatforms.filter(
        (p) => isListerPlatform(p) && MARKETPLACE_EXTENSION_FLOW[p] !== "verifying",
      ),
    [kitPlatforms],
  );
  const plan = useMemo(() => planListEverywhere(queueable, statuses), [queueable, statuses]);
  // The seller's ticks. Follows the plan's defaults until they touch a box,
  // then holds their choice until a send resets it.
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setChecked(new Set(plan.checked));
  }, [plan.checked, touched]);
  const crossPush = useCrossPush();

  const listEverywhere = async () => {
    if (!draft?.id) {
      toast.error("Save the eBay draft first.");
      return;
    }
    const platforms = queueable.filter((p) => checked.has(p) && !plan.disabled[p]);
    if (platforms.length === 0) {
      toast.error("Pick at least one marketplace.");
      return;
    }
    try {
      // The same fan-out the composer's Publish uses: one sibling row per
      // channel, pre-flighted, then a queue row for the desktop. The server
      // skips a channel that is already live or already waiting (US-3367), so
      // pressing this twice cannot mint a duplicate listing.
      const res = await crossPush.mutateAsync({
        listingId: draft.id,
        platforms: platforms as CrossListingPlatform[],
      });
      const queued: string[] = [];
      const live: string[] = [];
      const waiting: string[] = [];
      const blocked: string[] = [];
      for (const p of platforms) {
        const r = res.results[p as CrossListingPlatform];
        if (!r) continue;
        const name = MARKETPLACE_LABELS[p as ListingPlatform] ?? p;
        if (r.skipped === "already_live") live.push(name);
        else if (r.skipped === "already_queued") waiting.push(name);
        else if (r.ok && r.queued) queued.push(name);
        else if (!r.ok) blocked.push(`${name}: ${r.blockers?.[0] ?? r.error ?? "blocked"}`);
      }
      if (queued.length > 0) {
        // The shared sentence. A queued job is not a listed job.
        toast.success(`Queued for your desktop: ${queued.join(", ")}. ${QUEUED_NOTICE}`, {
          duration: 10_000,
        });
        void requestDrainNow();
      }
      if (live.length > 0) toast.info(`Already live: ${live.join(", ")}.`);
      if (waiting.length > 0) toast.info(`Already waiting for your desktop: ${waiting.join(", ")}.`);
      for (const b of blocked) toast.error(b, { duration: 12_000 });
      setTouched(false);
      void qc.invalidateQueries({ queryKey: ["extension_queue"] });
      void qc.invalidateQueries({ queryKey: ["item_listings", itemId] });
    } catch (err) {
      toastError(err, "Could not queue the cross-posts.");
    }
  };

  // The item's price candidates AND its current facts. The facts joined this
  // read on 2026-09-11 (channel-copy.ts): the title is the last-resort source
  // for a channel's title, and brand, colour and size beat the kit variant's
  // snapshot of them. The composer's save invalidates this key.
  const { data: itemPrice } = useQuery({
    queryKey: ["kit-item-facts", itemId],
    queryFn: async () => {
      const [{ data: row }, { data: priced }] = await Promise.all([
        supabase
          .from("inventory_items")
          .select("target_price, title, brand, color, size")
          .eq("id", itemId)
          .maybeSingle(),
        // The composer's third source is `item.list_price`, which is NOT a
        // column on inventory_items — it is an alias on the `items_full` VIEW
        // for a listing's own listing_price. Selecting it from inventory_items
        // fails the whole query, which is worse than the blank price it was
        // meant to fix. The equivalent, read from a table that has it: any of
        // this item's listing rows carrying a positive price.
        supabase
          .from("listings")
          .select("listing_price")
          .eq("inventory_item_id", itemId)
          .gt("listing_price", 0)
          .order("listing_price", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      const item = row as
        | (KitItemFacts & { target_price: number | null })
        | null;
      return {
        target_price: item?.target_price ?? null,
        facts: item
          ? { title: item.title, brand: item.brand, color: item.color, size: item.size }
          : null,
        any_listing_price:
          (priced as { listing_price: number | null } | null)?.listing_price ?? null,
      };
    },
  });
  // THE COMPOSER'S OWN RULE, copied whole rather than approximated.
  //
  // An item's price can live in three places and the composer has always known
  // that: `[listing.listing_price, item.target_price, item.list_price]`, first
  // POSITIVE value wins (composer.tsx). The third is the subtle one — it is a
  // column on the `items_full` VIEW, aliasing a listing's own price, and does
  // NOT exist on inventory_items. Asking that table for it fails the entire
  // query and loses target_price too, which is how "no price" survived two
  // fixes that were both individually correct.
  //
  // "First positive" is the load-bearing part, not "first non-null": a stale 0
  // on a draft row must not shadow a real price further down the list.
  const fallbackPrice =
    [
      draft?.listing_price,
      itemPrice?.target_price,
      itemPrice?.any_listing_price,
      // Coerced for the same reason as the variant: PostgREST hands back a
      // Postgres `numeric` as a STRING, and "32.49" > 0 is true by coercion
      // while `typeof === "number"` is false. Reading these raw is how a real
      // price behaves like a present value in one comparison and an absent one
      // in the next.
    ].map((p) => numericOr(p, 0)).find((p) => p > 0) ?? 0;

  // Seed from persisted platform_fields; overlay anything just generated.
  const variants = useMemo(() => {
    const map: Record<string, PlatformKitVariant> = {};
    const stored = (draft?.platform_fields ?? {}) as Record<string, Record<string, unknown>>;
    for (const [plat, raw] of Object.entries(stored)) {
      map[plat] = normalize(plat, raw);
    }
    for (const v of gen.data?.variants ?? []) {
      map[v.platform] = v;
    }
    return map;
  }, [draft?.platform_fields, gen.data]);

  const hasAny = Object.keys(variants).length > 0;

  // The descriptions, rendered NOW from the listing's blocks.
  //
  // `platform_fields[platform].description` is a snapshot of what the facts
  // were the last time the AI ran. This asks the edge for the same blocks eBay
  // renders, with each platform's own prose in place of the eBay wording, so a
  // measurement or a colour corrected in the composer reaches every channel
  // with no AI call and no button. Keyed on the listing id and the channel set;
  // the composer's save already invalidates ["platform-fields", itemId], and
  // this rides the same key so one save refreshes both.
  const { data: liveDescriptions } = useQuery({
    queryKey: ["platform-descriptions", draft?.id ?? null, kitPlatforms],
    enabled: Boolean(draft?.id) && kitPlatforms.length > 0,
    queryFn: async () => {
      const res = await edgeFetch(
        `/api/flipdesk/description/${draft!.id}/platform-descriptions` +
          `?platforms=${encodeURIComponent(kitPlatforms.join(","))}`,
      );
      if (!res.ok) return {} as Record<string, string>;
      const json = await res.json().catch(() => ({}));
      return (json.descriptions ?? {}) as Record<string, string>;
    },
  });
  // 2026-09-02: the batch worker fills the kit with the draft. Say so, because
  // a seller who never pressed the button is otherwise left wondering where
  // the copy came from.
  const generatedWithDraft = Object.values(variants).some((v) => v.generatedWithDraft);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle>Cross-list copy kit</CardTitle>
            <CardDescription>
              Every marketplace copies your eBay title and description, so a fix
              on eBay reaches them all. Type in a field to use different words on
              one site only.
              {generatedWithDraft
                ? " Filled automatically when this draft was generated."
                : null}
            </CardDescription>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              gen.mutate(
                { itemId, platforms: kitPlatforms },
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
        {/* US-3367: one button for every extension channel, through the paced
            queue. A live or queued channel is shown and disabled with the
            reason, so the list reads as the truth about the item rather than
            as a form. */}
        {queueable.length > 0 && (
          <div className="mb-4 space-y-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="text-sm font-medium">List on:</span>
              {queueable.map((p) => {
                const reason = plan.disabled[p];
                const id = `list-on-${p}`;
                return (
                  <label
                    key={p}
                    htmlFor={id}
                    className={cn(
                      "flex items-center gap-1.5 text-sm",
                      reason && "text-muted-foreground",
                    )}
                  >
                    <Checkbox
                      id={id}
                      checked={!reason && checked.has(p)}
                      disabled={Boolean(reason) || crossPush.isPending}
                      onCheckedChange={(v) => {
                        setTouched(true);
                        setChecked((prev) => {
                          const next = new Set(prev);
                          if (v === true) next.add(p);
                          else next.delete(p);
                          return next;
                        });
                      }}
                    />
                    {MARKETPLACE_LABELS[p as ListingPlatform] ?? p}
                    {reason ? ` (${reason})` : ""}
                  </label>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                size="sm"
                disabled={crossPush.isPending}
                onClick={() => void listEverywhere()}
              >
                {crossPush.isPending ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Send className="mr-1.5 h-4 w-4" />
                )}
                List everywhere
              </Button>
              <p className="text-xs text-muted-foreground">
                Runs one at a time in your own browser, about 30 seconds apart.{" "}
                {QUEUED_NOTICE}
              </p>
            </div>
          </div>
        )}

        <Tabs defaultValue={kitPlatforms[0]}>
          <TabsList className="flex-wrap">
            {kitPlatforms.map((p) => {
              const spec = getMarketplaceSpec(p);
              const v = variants[p];
              const hasErr = v ? !v.validation?.ok : false;
              const state = statuses[p]?.state;
              const name = spec?.label ?? p;
              return (
                <TabsTrigger key={p} value={p} className="gap-1.5">
                  {name}
                  {hasErr && <span className="h-1.5 w-1.5 rounded-full bg-brand-red" />}
                  {/* US-3367: the channel's state, at a glance. The label names
                      the channel so a screen reader hears which tab is live. */}
                  {state === "live" && (
                    <span
                      className="h-1.5 w-1.5 rounded-full bg-emerald-500"
                      role="img"
                      aria-label={`${name}: live`}
                    />
                  )}
                  {(state === "queued" || state === "delist_queued") && (
                    <Clock className="h-3 w-3 text-muted-foreground" aria-label={`${name}: queued`} />
                  )}
                  {state === "failed" && (
                    <XCircle className="h-3 w-3 text-brand-red-text" aria-label={`${name}: needs you`} />
                  )}
                </TabsTrigger>
              );
            })}
          </TabsList>
          {/* The same narrowed list as the triggers above. This iterated the
              unnarrowed KIT_PLATFORMS until 2026-09-02, rendering hidden
              panels for channels the seller had switched off. */}
          {kitPlatforms.map((p) => (
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
                channelPrice={data?.channelPrices[p] ?? null}
                fallbackPrice={fallbackPrice}
                photos={photos}
                primaryId={primaryId}
                baseName={baseName ?? `item-${itemId.slice(0, 8)}`}
                itemId={itemId}
                liveDescription={liveDescriptions?.[p] || undefined}
                listingId={draft?.id ?? null}
                sharedTitle={draft?.listing_title ?? null}
                itemFacts={itemPrice?.facts ?? null}
                overrides={readChannelOverrides(draft?.platform_fields?.[p])}
                status={statuses[p] ?? deriveChannelState([], [], p)}
              />
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}

/**
 * A number from whatever the JSON blob actually holds. (US-2740)
 *
 * Accepts a number or a numeric string; anything else — null, "", "TBD", an
 * object — returns the fallback. Deliberately strict about what counts: a
 * price is money, and coercing junk into one would put it on a live listing.
 */
/**
 * A price in the units the marketplace actually accepts (US-2739).
 *
 * RE-EXPORTED, not defined here any more. The body moved to
 * src/lib/marketplace-price.ts, which is the one place that knows a
 * marketplace's price units and is mirrored into the edge — because this file
 * was NOT the only thing building a price for the extension. The server builds
 * the same payload for anything queued from a phone, and it had no idea
 * Poshmark prices in whole dollars.
 *
 * The name stays exported from here because that is what src/test/step-price.test.ts
 * and the placement scans in cross-post-setup.test.ts call, and where the
 * stepping is APPLIED is still a property worth holding.
 */
export { stepPrice };

/**
 * What this channel costs, on the desk path. (US-3317)
 *
 * ORDERS THE CANDIDATES; it does not decide between them. The deciding is
 * `resolveSiblingPrice`, which the cross-push fan-out and the queued extension
 * job already share, and which also applies the marketplace's own price step.
 * A second rule here is what the story exists to prevent.
 *
 * The candidates, in the order `buildListPayload` reads them on the edge:
 *
 *   1. channelPrice  — this channel's OWN sibling `listings` row.
 *   2. variantPrice  — the kit variant's stored price, a snapshot of the shared
 *                      price from whenever the kit last ran.
 *   3. fallbackPrice — the item's shared price (eBay draft, then target price).
 *
 * WHY `overridePrice` AND NOT `explicitPrice`. The explicit slot means "the
 * seller typed a price for this channel on THIS push", and the desk has no such
 * field: the Listing Kit's price row is read-only and this function writes
 * nothing. Putting the stored channel price in the slot reserved for a typed one
 * would make the next person to add that field find it already occupied.
 *
 * EXPORTED FOR TEST, and the test that matters is the equality one: the same
 * item sent to the same channel through here and through the edge's
 * `buildListPayload` has to come out at the same integer cents.
 */
export function resolveKitPrice(
  platform: MarketplacePlatform,
  input: {
    /** This channel's own recorded price. Null when it has no row yet. */
    channelPrice?: number | null;
    /** `platform_fields[platform].price` — 0 on every pre-US-2736 draft. */
    variantPrice?: number | null;
    /** The item's shared price. 0 means the item has none anywhere. */
    fallbackPrice?: number | null;
  },
): ResolvedSiblingPrice {
  const variantPrice = numericOr(input.variantPrice, 0);
  return resolveSiblingPrice(platform, {
    overridePrice: input.channelPrice,
    // First POSITIVE, not first non-null: a variant generated before the server
    // learned about prices carries 0, and a 0 must not shadow the item's real
    // shared price further down the list.
    sharedPrice: variantPrice > 0 ? variantPrice : input.fallbackPrice,
  });
}

/** One `listings` row, as the kit reads it. */
export interface KitListingRow {
  id: string;
  platform: string | null;
  platform_fields: Record<string, unknown> | null;
  primary_photo_id: string | null;
  listing_price: number | null;
  /** The eBay title every channel copies. Optional: older callers omit it. */
  listing_title?: string | null;
}

export interface KitListings {
  /** The eBay draft: the words, the cover photo and the shared price. */
  draft: KitListingRow | null;
  /** Dollars per platform, positive only. Absent means "no row for it". */
  channelPrices: Record<string, number>;
}

/**
 * Split this item's `listings` rows into the draft and the per-channel prices.
 * (US-3317)
 *
 * The query used to be `.eq("platform", "ebay")`, so the only price the desk
 * could see was the shared one — and a channel priced deliberately higher or
 * lower had its OWN row sitting right there, unread, while the extension was
 * handed eBay's number to type. The eBay row is still the draft; the siblings
 * are now read alongside it for the one field that is per-channel. The same
 * change US-2736 made to `hydrateListRows`, which this file was fenced out of.
 *
 * A channel's price is its row's `listing_price`, and ONLY that — the same
 * single field `hydrateListRows` reads for the queued path, deliberately, so the
 * two cannot answer differently. `platform_fields[platform].price_override` is
 * the seller's per-channel INTENT and is the input cross-push resolves the row's
 * price from; it is written by `mapSiblingListingFields` in the same statement
 * that writes `listing_price`, so a row can never carry one without the other.
 * Reading it here as a second candidate would add a case that cannot happen in
 * production and CAN differ from the queue, which is a fourth opinion bought for
 * nothing.
 *
 * A row carrying 0 (created by an extension writeback, never pushed) contributes
 * nothing and the shared price is used — first POSITIVE, not first non-null.
 * Rows arrive newest-first, so the first positive one per platform wins.
 */
export function readKitListings(rows: readonly KitListingRow[]): KitListings {
  let draft: KitListingRow | null = null;
  const channelPrices: Record<string, number> = {};
  for (const row of rows) {
    const platform = row.platform ?? "";
    if (!draft && platform === "ebay") draft = row;
    if (!platform || channelPrices[platform] !== undefined) continue;
    // Coerced for the same reason every other price on this path is: PostgREST
    // hands back a Postgres `numeric` as a STRING, and "40.49" is a real price
    // that `typeof === "number"` calls absent.
    const price = numericOr(row.listing_price, 0);
    if (price > 0) channelPrices[platform] = price;
  }
  return { draft, channelPrices };
}

/**
 * A number, from a number or a numeric string, or the fallback.
 *
 * EXPORTED FOR TEST (US-2740). It was private, and the suite covering it could
 * only assert that the name appeared in the source — which passed happily while
 * the body was reverted to the strict `typeof` check that caused the original
 * bug. A source scan cannot see behaviour; this needs to be callable.
 *
 * Deliberately strict about what counts as a number. A price is money, and
 * coercing '', 'TBD', NaN or an object into one puts it on a live listing.
 */
export function numericOr(value: unknown, fallback: number): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
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
    style: typeof raw.style === "string" ? raw.style : null,
    generatedWithDraft: raw.generated_with_draft === true,
    // US-2740: a numeric STRING is a price, not a zero.
    //
    // This was `typeof raw.price === "number" ? raw.price : 0`, which silently
    // turns "32.49" into 0 — a blank Listing price on a draft that plainly has
    // one. Two ordinary things produce that string: PostgREST returns Postgres
    // `numeric` as a string to avoid float precision loss, and anything that
    // round-trips this blob through a form or a JSON edit stores it as text.
    // The item that exposed it had platform_fields->poshmark->price sitting
    // right there at 32.49 while every surface showed nothing.
    //
    // Coerced rather than trusted: a non-numeric value still becomes 0, so junk
    // in the blob cannot become a price on a live listing.
    price: numericOr(raw.price, 0),
    tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : [],
    confidence: numericOr(raw.confidence, 0),
    validation,
  };
}
