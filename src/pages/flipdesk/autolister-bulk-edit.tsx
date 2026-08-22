import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { BatchNav } from "./autolister/batch-nav";
import {
  CategorySearchControl,
  DescriptionCell,
  PnlCell,
  PolicyBadges,
  SpecificsCell,
} from "./autolister/bulk-edit-cells";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Loader2,
  Save,
  AlertTriangle,
  ArrowRight,
  ShieldCheck,
  Replace,
  Wand2,
  LayoutTemplate,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingRegion } from "@/components/ui/skeletons";
import { supabase } from "@/lib/supabase";
import { edgeFetch } from "@/lib/edge-fetch";
import {
  useEbayCategoryAspects,
  useEbayPolicies,
  useAiExtractAspects,
} from "@/hooks/use-ebay";
import { EBAY_CONDITION_OPTIONS, EBAY_DEPARTMENT_OPTIONS } from "@/lib/constants";
import { cn, isoToLocalInput, localInputToIso } from "@/lib/utils";
import { AiDiffChip } from "@/components/flipdesk/ai-diff-chip";
import { marginFloorWithPostage } from "@/lib/margin-floor";
import { useItemAttrs } from "./autolister/use-item-attrs";
import {
  aiAspect,
  aiPriceInput,
  conditionLabel,
  formatAiPrice,
  priceChanged,
  textChanged,
  type ListingAiSnapshot,
} from "@/lib/listing-ai-diff";
import { reverseProjectAspectColumns } from "@/lib/ebay-prefill";
import { pruneSources, type AspectSourceMap } from "@/lib/aspect-provenance";

// AutoLister bulk spreadsheet editor (US-320). Edit a whole generated batch in
// a grid — inline title/price/condition/quantity/best-offer — with bulk-apply
// actions, then save everything at once. Scoped to one batch's drafts.

import { changesFromItemDiff } from "@/lib/title-sync";
import { buildTitleSyncPatch } from "@/lib/title-sync-patch";
import { itemRowLabel, rowControlLabel } from "@/lib/item-row-label";

const TITLE_MAX = 80;

// Aspects that have their own dedicated grid columns — excluded from the generic
// Specifics popover so they aren't edited in two places (US-556).
const DEDICATED_ASPECTS = ["Department", "Brand", "Size", "Color"];

interface DraftRow {
  id: string;
  inventory_item_id: string;
  listing_title: string | null;
  listing_description: string | null;
  listing_price: number | null;
  ebay_condition: string | null;
  quantity: number | null;
  best_offer_enabled: boolean | null;
  // US-562 / US-2405: per-listing best-offer auto-clear thresholds (cents), set
  // by hand. Null → no threshold at publish.
  best_offer_auto_accept_cents: number | null;
  best_offer_auto_decline_cents: number | null;
  scheduled_publish_at: string | null;
  platform_category_id: string | null;
  item_specifics_override: Record<string, string[]> | null;
  // US-825 provenance parallel to item_specifics_override — read so a bulk
  // Brand/Size/Color edit can be stamped "manual" without losing AI stamps.
  item_specifics_sources: AspectSourceMap | null;
  ai_generated_snapshot: ListingAiSnapshot | null;
  // US-1995: needed to sync the title when a bulk Brand/Size/Color/Style edit
  // reverse-projects onto the item. listing_origin is the sync-precedence guard
  // (never rewrite an eBay-owned title); title_variants because a stale brand in
  // variant B is the same bug, just less visible.
  listing_origin: string | null;
  title_variants: unknown;
  // US-553: comp-derived price range (p25/p75) for the "median comp − X%" rule.
  price_range_low_cents: number | null;
  price_range_high_cents: number | null;
  // US-555: per-listing eBay business-policy overrides (bulk-assigned here,
  // applied at publish over the account defaults).
  shipping_policy_id: string | null;
  payment_policy_id: string | null;
  return_policy_id: string | null;
}

// US-555: a saved listing preset (listing_templates, US-674) the seller can
// apply across a whole batch from the bulk grid.
interface ListingTemplate {
  id: string;
  name: string;
  description_template: string | null;
  ebay_condition: string | null;
  item_specifics: Record<string, string[] | string> | null;
  ebay_category_id: string | null;
  return_policy_id: string | null;
  shipping_policy_id: string | null;
  payment_policy_id: string | null;
  is_default: boolean;
}

interface EditRow {
  id: string;
  itemId: string;
  title: string;
  // US-556: listing body, editable inline via the Description popover cell. Also
  // rewritten by bulk find/replace and seeded by templates.
  description: string;
  price: string;
  condition: string;
  quantity: string;
  bestOffer: boolean;
  // US-562 / US-2405: per-item best-offer thresholds (dollars, as typed). Empty
  // string → NULL → no threshold is sent and every offer waits for the seller.
  bestOfferAccept: string;
  bestOfferDecline: string;
  scheduledAt: string;
  categoryId: string;
  // Human-readable category path for display (e.g. "…> Women > Women's Clothing").
  // Populated when the user picks via search; the DB only stores the leaf id, so
  // it's empty for categories loaded from the server until re-picked.
  categoryPath: string;
  // eBay item specifics edited inline. Department/Brand/Size/Color are the
  // required clothing aspects that most often block publish; they're merged into
  // item_specifics_override on save. A blank value falls back to the item's
  // derived column server-side. `specifics` holds the rest of the override —
  // editable inline via the Specifics popover cell (US-556) and merged back
  // losslessly on save.
  department: string;
  brand: string;
  size: string;
  color: string;
  specifics: Record<string, string[]>;
  // Saved provenance for the override (US-825), carried through the save.
  sources: AspectSourceMap;
  // The inline aspects as loaded — a field that differs from its seed at save
  // time was edited by the seller THIS session, so it's stamped "manual" and
  // reverse-synced to the item (single-entry rule).
  seedInline: { department: string; brand: string; size: string; color: string };
  // US-551: the AI's original draft, snapshotted at generation. Drives the
  // per-field diff chips + revert-to-AI. Null for manually-created drafts.
  ai: ListingAiSnapshot | null;
  // US-1995: inputs for the backwards title sync on save. listingOrigin is the
  // sync-precedence guard (never rewrite an eBay-owned title); titleVariants so
  // both A/B variants move together.
  listingOrigin: string | null;
  titleVariants: unknown;
  // US-553: comp-derived price range (dollars) for the "median comp − X%" rule.
  compLow: number | null;
  compHigh: number | null;
  // US-555: per-listing eBay business-policy overrides.
  shippingPolicyId: string;
  paymentPolicyId: string;
  returnPolicyId: string;
  // Server-side validation blockers (US-320) — populated by "Validate" actions.
  validationBlockers: string[] | null;
  dirty: boolean;
}

function roundTo99(p: number): number {
  if (p < 1) return Math.round(p * 100) / 100;
  return Math.floor(p) + 0.99;
}

// US-562: parse a dollar-string best-offer threshold into whole cents. Blank or
// non-positive input → null (clears the override; comp default applies).
function dollarsToCentsOrNull(value: string): number | null {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

export function FlipdeskAutolisterBulkEditPage() {
  const [params] = useSearchParams();
  const batchId = params.get("batch");
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["autolister_batch_drafts", batchId],
    enabled: !!batchId,
    queryFn: async (): Promise<DraftRow[]> => {
      const { data: rows, error: err } = await supabase
        .from("listings")
        .select(
          "id, inventory_item_id, listing_title, listing_description, listing_price, ebay_condition, quantity, best_offer_enabled, best_offer_auto_accept_cents, best_offer_auto_decline_cents, scheduled_publish_at, platform_category_id, item_specifics_override, item_specifics_sources, ai_generated_snapshot, price_range_low_cents, price_range_high_cents, shipping_policy_id, payment_policy_id, return_policy_id, listing_origin, title_variants",
        )
        .eq("batch_id", batchId!)
        .eq("listing_status", "draft");
      if (err) throw err;
      return (rows ?? []) as DraftRow[];
    },
  });

  const itemIds = useMemo(
    () => (data ?? []).map((r) => r.inventory_item_id),
    [data],
  );
  const { data: itemAttrs = {} } = useItemAttrs(batchId, itemIds);

  const [rows, setRows] = useState<EditRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [markupPct, setMarkupPct] = useState("");
  // US-553: bulk price rules beyond markup/.99.
  const [medianDiscountPct, setMedianDiscountPct] = useState("");
  const [marginFloorPct, setMarginFloorPct] = useState("");
  const [bulkCondition, setBulkCondition] = useState("");
  const [bulkQty, setBulkQty] = useState("");
  const [bulkSchedule, setBulkSchedule] = useState("");
  const [bulkCategory, setBulkCategory] = useState<{
    id: string;
    path: string;
  } | null>(null);
  const [bulkDepartment, setBulkDepartment] = useState("");
  const [bulkBrand, setBulkBrand] = useState("");
  // US-555: find/replace across titles + descriptions.
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [findScope, setFindScope] = useState<"title" | "description" | "both">(
    "title",
  );
  // US-555: bulk business-policy assignment (fulfillment/payment/return).
  const [bulkPolicy, setBulkPolicy] = useState({
    fulfillment: "",
    payment: "",
    return: "",
  });
  const [aiFilling, setAiFilling] = useState(false);
  const [applyingDefaults, setApplyingDefaults] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  // US-555: required item-specifics per category, refreshed when a bulk category
  // is applied (the "aspect cascade"). rowIssues flags rows missing them.
  const [requiredAspectsByCategory, setRequiredAspectsByCategory] = useState<
    Record<string, string[]>
  >({});

  const policiesQuery = useEbayPolicies();
  // Aspect spec for the category staged in the bulk toolbar — drives the cascade.
  const bulkCatAspects = useEbayCategoryAspects(bulkCategory?.id ?? null);
  const aiExtract = useAiExtractAspects();

  // Policy id → human label, so the per-row policy column reads meaningfully.
  const policyLabel = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of policiesQuery.data?.policies ?? []) {
      map[p.policy_id] = p.policy_name;
    }
    return map;
  }, [policiesQuery.data]);

  const fulfillmentPolicies =
    policiesQuery.data?.policies.filter((p) => p.policy_type === "fulfillment") ??
      [];
  const paymentPolicies =
    policiesQuery.data?.policies.filter((p) => p.policy_type === "payment") ?? [];
  const returnPolicies =
    policiesQuery.data?.policies.filter((p) => p.policy_type === "return") ?? [];

  // US-555: the seller's saved listing templates (listing_templates / US-674).
  const templatesQuery = useQuery({
    queryKey: ["flipdesk_listing_templates"],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<ListingTemplate[]> => {
      const res = await edgeFetch("/api/flipdesk/templates");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not load templates.");
      return (json.templates ?? []) as ListingTemplate[];
    },
  });

  // Seed editable rows once the drafts load.
  useEffect(() => {
    if (!data) return;
    setRows(
      data.map((r) => {
        // Split the inline-editable aspects out of the override so their fields
        // own them; `specifics` keeps the remaining aspects untouched for a
        // lossless merge on save.
        const override = r.item_specifics_override ?? {};
        const { Department, Brand, Size, Color, ...rest } = override;
        return {
          id: r.id,
          itemId: r.inventory_item_id,
          title: r.listing_title ?? "",
          description: r.listing_description ?? "",
          price: r.listing_price != null ? String(r.listing_price) : "",
          condition: r.ebay_condition ?? "",
          quantity: r.quantity != null ? String(r.quantity) : "1",
          bestOffer: r.best_offer_enabled ?? false,
          bestOfferAccept:
            r.best_offer_auto_accept_cents != null
              ? (r.best_offer_auto_accept_cents / 100).toFixed(2)
              : "",
          bestOfferDecline:
            r.best_offer_auto_decline_cents != null
              ? (r.best_offer_auto_decline_cents / 100).toFixed(2)
              : "",
          scheduledAt: isoToLocalInput(r.scheduled_publish_at),
          categoryId: r.platform_category_id ?? "",
          categoryPath: "",
          department: Department?.[0] ?? "",
          brand: Brand?.[0] ?? "",
          size: Size?.[0] ?? "",
          color: Color?.[0] ?? "",
          specifics: rest,
          sources: r.item_specifics_sources ?? {},
          seedInline: {
            department: Department?.[0] ?? "",
            brand: Brand?.[0] ?? "",
            size: Size?.[0] ?? "",
            color: Color?.[0] ?? "",
          },
          ai: r.ai_generated_snapshot ?? null,
          listingOrigin: r.listing_origin ?? null,
          titleVariants: r.title_variants ?? null,
          compLow:
            r.price_range_low_cents != null ? r.price_range_low_cents / 100 : null,
          compHigh:
            r.price_range_high_cents != null
              ? r.price_range_high_cents / 100
              : null,
          shippingPolicyId: r.shipping_policy_id ?? "",
          paymentPolicyId: r.payment_policy_id ?? "",
          returnPolicyId: r.return_policy_id ?? "",
          validationBlockers: null,
          dirty: false,
        };
      }),
    );
  }, [data]);

  const dirtyCount = rows.filter((r) => r.dirty).length;
  const targetIds = selected.size > 0 ? selected : new Set(rows.map((r) => r.id));

  function patchRow(id: string, patch: Partial<EditRow>) {
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch, dirty: true } : r)),
    );
  }

  function applyToTargets(fn: (r: EditRow) => Partial<EditRow>) {
    setRows((prev) =>
      prev.map((r) => (targetIds.has(r.id) ? { ...r, ...fn(r), dirty: true } : r)),
    );
  }

  function applyMarkup() {
    const pct = Number.parseFloat(markupPct);
    if (!Number.isFinite(pct)) return;
    applyToTargets((r) => {
      const base = Number.parseFloat(r.price);
      if (!Number.isFinite(base)) return {};
      return { price: (base * (1 + pct / 100)).toFixed(2) };
    });
  }

  function applyRound99() {
    applyToTargets((r) => {
      const base = Number.parseFloat(r.price);
      if (!Number.isFinite(base)) return {};
      return { price: roundTo99(base).toFixed(2) };
    });
  }

  // US-553: price = median comp − X%. The median is the midpoint of the stored
  // p25/p75 comp range; rows without comps are left untouched and counted so the
  // seller knows the rule didn't cover everything.
  function applyMedianComp() {
    const pct = Number.parseFloat(medianDiscountPct);
    if (!Number.isFinite(pct)) return;
    let skipped = 0;
    applyToTargets((r) => {
      if (r.compLow == null || r.compHigh == null) {
        skipped++;
        return {};
      }
      const median = (r.compLow + r.compHigh) / 2;
      return { price: Math.max(0, median * (1 - pct / 100)).toFixed(2) };
    });
    if (skipped > 0) {
      toast.info(
        `${skipped} row${skipped === 1 ? "" : "s"} had no comps and kept their price.`,
      );
    }
  }

  // US-553: raise any price below the floor that yields at least X% net margin
  // (cost basis + eBay fees factored in). Prices already above the floor are
  // left alone — this only protects the downside.
  function applyMarginFloor() {
    const pct = Number.parseFloat(marginFloorPct);
    if (!Number.isFinite(pct)) return;
    let unreachable = 0;
    let noPostage = 0;
    applyToTargets((r) => {
      // US-2790: postage was missing here, so the floor priced shipping at
      // zero. Rule lives in lib/margin-floor.ts — three surfaces need it.
      const attrs = itemAttrs[r.itemId];
      const { floor, postageUnknown } = marginFloorWithPostage(
        {
          garmentCategory: attrs?.garmentCategory ?? null,
          material: attrs?.material || null,
          measurements: attrs?.measurements ?? null,
          size: attrs?.size || null,
        },
        pct,
        attrs?.cost ?? null,
      );
      if (postageUnknown) noPostage++;
      if (floor == null) {
        unreachable++;
        return {};
      }
      const base = Number.parseFloat(r.price);
      const next = Number.isFinite(base) ? Math.max(base, floor) : floor;
      return { price: roundTo99(next).toFixed(2) };
    });
    if (unreachable > 0) {
      toast.warning(
        `${pct}% margin is unreachable with eBay fees for ${unreachable} row${unreachable === 1 ? "" : "s"}.`,
      );
    }
    // US-2790: these rows got the OLD free-postage behaviour, so say so.
    if (noPostage > 0) {
      toast.warning(
        `${noPostage} row${noPostage === 1 ? "" : "s"} priced without a postage estimate ` +
          `— heavier than any rate we have. Check those by hand.`,
      );
    }
  }

  // US-553: reset price to the AI's original recommendation (snapshot). Rows
  // with no AI snapshot (manually created) are skipped.
  function applyMatchRecommended() {
    let skipped = 0;
    applyToTargets((r) => {
      const cents = r.ai?.price_cents;
      if (cents == null) {
        skipped++;
        return {};
      }
      return { price: (cents / 100).toFixed(2) };
    });
    if (skipped > 0) {
      toast.info(
        `${skipped} row${skipped === 1 ? "" : "s"} had no AI recommendation and kept their price.`,
      );
    }
  }

  // US-555: literal find/replace across titles and/or descriptions of the
  // targeted rows. Title results are clamped to the 80-char limit. Reports how
  // many occurrences changed so a no-op is obvious.
  function applyFindReplace() {
    if (!findText) return;
    const doTitle = findScope === "title" || findScope === "both";
    const doDesc = findScope === "description" || findScope === "both";
    let titleHits = 0;
    let descHits = 0;
    setRows((prev) =>
      prev.map((r) => {
        if (!targetIds.has(r.id)) return r;
        const patch: Partial<EditRow> = {};
        let changed = false;
        if (doTitle && r.title.includes(findText)) {
          titleHits += r.title.split(findText).length - 1;
          patch.title = r.title.split(findText).join(replaceText).slice(0, TITLE_MAX);
          changed = true;
        }
        if (doDesc && r.description.includes(findText)) {
          descHits += r.description.split(findText).length - 1;
          patch.description = r.description.split(findText).join(replaceText);
          changed = true;
        }
        return changed ? { ...r, ...patch, dirty: true } : r;
      }),
    );
    const total = titleHits + descHits;
    if (total === 0) {
      toast.info(`"${findText}" not found in the targeted rows.`);
    } else {
      toast.success(
        `Replaced ${total} occurrence${total === 1 ? "" : "s"} — ${titleHits} in titles, ${descHits} in descriptions.`,
      );
    }
  }

  // US-555: required aspect names for a category's aspect spec (eBay requires
  // these item specifics before publish).
  function requiredAspectNames(
    resp: typeof bulkCatAspects.data,
  ): string[] {
    return (resp?.aspects.aspects ?? [])
      .filter((a) => a.aspectConstraint?.aspectRequired)
      .map((a) => a.localizedAspectName);
  }

  // US-555: apply the staged bulk category AND refresh the required-specifics
  // list for it (the aspect cascade). Rows then flag any required aspect they
  // don't yet cover.
  function applyBulkCategory() {
    if (!bulkCategory) return;
    const required = requiredAspectNames(bulkCatAspects.data);
    setRequiredAspectsByCategory((prev) => ({
      ...prev,
      [bulkCategory.id]: required,
    }));
    applyToTargets(() => ({
      categoryId: bulkCategory.id,
      categoryPath: bulkCategory.path,
    }));
    if (required.length > 0) {
      toast.info(`Required item specifics now: ${required.join(", ")}.`);
    }
  }

  // US-555: assign the chosen business policies to the targeted rows. Any subset
  // (e.g. only the return policy) is allowed; unset selectors are left as-is.
  function applyPolicies() {
    const patch: Partial<EditRow> = {};
    if (bulkPolicy.fulfillment) patch.shippingPolicyId = bulkPolicy.fulfillment;
    if (bulkPolicy.payment) patch.paymentPolicyId = bulkPolicy.payment;
    if (bulkPolicy.return) patch.returnPolicyId = bulkPolicy.return;
    if (Object.keys(patch).length === 0) {
      toast.info("Pick at least one policy to assign.");
      return;
    }
    applyToTargets(() => patch);
  }

  // The aspects already known for a row — passed to the AI so it skips them and
  // we never clobber a seller's manual value.
  function knownAspectsFor(r: EditRow): Record<string, string[]> {
    const known: Record<string, string[]> = { ...r.specifics };
    if (r.department.trim()) known.Department = [r.department.trim()];
    if (r.brand.trim()) known.Brand = [r.brand.trim()];
    if (r.size.trim()) known.Size = [r.size.trim()];
    if (r.color.trim()) known.Color = [r.color.trim()];
    return known;
  }

  // Merge AI aspect suggestions into a row, only filling EMPTY fields and only
  // when the model is reasonably confident.
  function mergeAiSuggestions(
    r: EditRow,
    suggestions: Record<string, { values: string[]; confidence: number }>,
  ): Partial<EditRow> {
    const patch: Partial<EditRow> = {};
    const specifics = { ...r.specifics };
    for (const [name, s] of Object.entries(suggestions)) {
      const values = (s.values ?? []).filter((v) => v.trim());
      if (values.length === 0 || s.confidence < 0.5) continue;
      const first = values[0]!;
      if (name === "Department") {
        if (!r.department.trim()) patch.department = first;
      } else if (name === "Brand") {
        if (!r.brand.trim()) patch.brand = first;
      } else if (name === "Size") {
        if (!r.size.trim()) patch.size = first;
      } else if (name === "Color") {
        if (!r.color.trim()) patch.color = first;
      } else if (!specifics[name]?.length) {
        specifics[name] = values;
      }
    }
    patch.specifics = specifics;
    return patch;
  }

  // US-555: AI aspect-fill across the batch. Only rows with a category set can
  // be filled (the spec depends on the category). Bounded concurrency so a big
  // batch doesn't hammer the AI endpoint.
  async function aiFillSpecifics() {
    const targets = rows.filter((r) => targetIds.has(r.id) && r.categoryId.trim());
    if (targets.length === 0) {
      toast.info("Select rows with a category set first.");
      return;
    }
    setAiFilling(true);
    try {
      const CONCURRENCY = 3;
      let filled = 0;
      for (let i = 0; i < targets.length; i += CONCURRENCY) {
        const batch = targets.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map(async (row) => {
            try {
              const resp = await aiExtract.mutateAsync({
                itemId: row.itemId,
                categoryId: row.categoryId,
                categoryPath: row.categoryPath || undefined,
                knownAspects: knownAspectsFor(row),
              });
              return { id: row.id, suggestions: resp.suggestions };
            } catch {
              return { id: row.id, suggestions: null };
            }
          }),
        );
        setRows((prev) =>
          prev.map((r) => {
            const hit = results.find((x) => x.id === r.id);
            if (!hit || !hit.suggestions) return r;
            return { ...r, ...mergeAiSuggestions(r, hit.suggestions), dirty: true };
          }),
        );
        filled += results.filter((x) => x.suggestions).length;
      }
      toast.success(
        `AI filled specifics for ${filled} of ${targets.length} row${targets.length === 1 ? "" : "s"}.`,
      );
    } finally {
      setAiFilling(false);
    }
  }

  // US-555: apply a saved template to the targeted rows. Only fills empty fields
  // so it never overwrites edits already made; merges the template's item
  // specifics, condition, category, policies, and description footer.
  function applyTemplate() {
    const t = templatesQuery.data?.find((x) => x.id === selectedTemplateId);
    if (!t) return;
    applyToTargets((r) => {
      const patch: Partial<EditRow> = {};
      if (t.ebay_condition && !r.condition) patch.condition = t.ebay_condition;
      if (t.ebay_category_id) patch.categoryId = t.ebay_category_id;
      if (t.shipping_policy_id) patch.shippingPolicyId = t.shipping_policy_id;
      if (t.payment_policy_id) patch.paymentPolicyId = t.payment_policy_id;
      if (t.return_policy_id) patch.returnPolicyId = t.return_policy_id;
      if (t.description_template && !r.description.trim()) {
        patch.description = t.description_template;
      }
      const specifics = { ...r.specifics };
      for (const [name, raw] of Object.entries(t.item_specifics ?? {})) {
        const values = (Array.isArray(raw) ? raw : [String(raw)]).filter((v) =>
          v.trim()
        );
        if (values.length === 0) continue;
        const first = values[0]!;
        if (name === "Department") {
          if (!r.department.trim()) patch.department = first;
        } else if (name === "Brand") {
          if (!r.brand.trim()) patch.brand = first;
        } else if (name === "Size") {
          if (!r.size.trim()) patch.size = first;
        } else if (name === "Color") {
          if (!r.color.trim()) patch.color = first;
        } else if (!specifics[name]?.length) {
          specifics[name] = values;
        }
      }
      patch.specifics = specifics;
      return patch;
    });
    toast.success(`Applied template "${t.name}".`);
  }

  // US-555: smart defaults learned from the seller's last N non-draft listings —
  // the most common condition + business policies. Only fills empty fields. RLS
  // scopes the query to the seller's own listings.
  async function applySmartDefaults() {
    setApplyingDefaults(true);
    try {
      const { data: recent, error: recentErr } = await supabase
        .from("listings")
        .select(
          "ebay_condition, shipping_policy_id, payment_policy_id, return_policy_id",
        )
        .eq("platform", "ebay")
        .neq("listing_status", "draft")
        .order("created_at", { ascending: false })
        .limit(25);
      if (recentErr) throw recentErr;
      const recentRows = (recent ?? []) as Array<{
        ebay_condition: string | null;
        shipping_policy_id: string | null;
        payment_policy_id: string | null;
        return_policy_id: string | null;
      }>;
      if (recentRows.length === 0) {
        toast.info("No recent published listings to learn defaults from yet.");
        return;
      }
      const mostCommon = (pick: (r: (typeof recentRows)[number]) => string | null) => {
        const counts = new Map<string, number>();
        for (const r of recentRows) {
          const v = pick(r);
          if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
        }
        let best: string | null = null;
        let bestN = 0;
        for (const [v, n] of counts) {
          if (n > bestN) {
            best = v;
            bestN = n;
          }
        }
        return best;
      };
      const condition = mostCommon((r) => r.ebay_condition);
      const ship = mostCommon((r) => r.shipping_policy_id);
      const pay = mostCommon((r) => r.payment_policy_id);
      const ret = mostCommon((r) => r.return_policy_id);
      // Fall back to the account default policies when recent listings carried
      // no per-listing override.
      const defaults = policiesQuery.data?.defaults;
      const shipFinal = ship ?? defaults?.fulfillment_policy_id ?? "";
      const payFinal = pay ?? defaults?.payment_policy_id ?? "";
      const retFinal = ret ?? defaults?.return_policy_id ?? "";
      applyToTargets((r) => {
        const patch: Partial<EditRow> = {};
        if (condition && !r.condition) patch.condition = condition;
        if (shipFinal && !r.shippingPolicyId) patch.shippingPolicyId = shipFinal;
        if (payFinal && !r.paymentPolicyId) patch.paymentPolicyId = payFinal;
        if (retFinal && !r.returnPolicyId) patch.returnPolicyId = retFinal;
        return patch;
      });
      toast.success("Applied smart defaults from your recent listings.");
    } catch (err) {
      toast.error(
        `Could not load smart defaults: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setApplyingDefaults(false);
    }
  }

  // Persists ONE dirty row's edits to its listings row. Merges the inline
  // aspect columns back into item_specifics_override losslessly, the same model
  // the composer now writes (US-557). Throws on the row's own error so the
  // caller can isolate that single failure.
  async function saveRow(r: EditRow): Promise<void> {
    const price = Number.parseFloat(r.price);
    const qty = Number.parseInt(r.quantity, 10);
    // Re-merge the inline aspects back into the rest of the specifics. A
    // blank value drops the key (server re-derives it from the item's
    // column); null the whole column when nothing's left.
    const mergedSpecifics: Record<string, string[]> = {};
    // Carry the arbitrary specifics, dropping any key the user left with
    // no non-blank values (US-556: the popover can stage an empty key).
    for (const [k, vals] of Object.entries(r.specifics)) {
      const cleaned = (vals ?? []).map((v) => v.trim()).filter(Boolean);
      if (cleaned.length > 0) mergedSpecifics[k] = cleaned;
    }
    const setOrDrop = (key: string, value: string) => {
      const v = value.trim();
      if (v) mergedSpecifics[key] = [v];
      else delete mergedSpecifics[key];
    };
    setOrDrop("Department", r.department);
    setOrDrop("Brand", r.brand);
    setOrDrop("Size", r.size);
    setOrDrop("Color", r.color);
    // US-825: stamp the inline aspects the seller changed THIS session (value
    // differs from its load-time seed) as "manual", merged over the saved
    // provenance and pruned to keys that still hold a value. Without the stamp
    // a bulk-typed Brand stays unattributed and the publish path's column
    // re-assert would clobber it with the stale item column.
    const mergedSources: AspectSourceMap = { ...r.sources };
    const inline = [
      ["Department", r.department, r.seedInline.department],
      ["Brand", r.brand, r.seedInline.brand],
      ["Size", r.size, r.seedInline.size],
      ["Color", r.color, r.seedInline.color],
    ] as const;
    for (const [key, value, seed] of inline) {
      if (value.trim() && value.trim() !== seed.trim()) {
        mergedSources[key] = "manual";
      }
    }
    const prunedSources = pruneSources(mergedSources, mergedSpecifics);
    const { error: upErr } = await supabase
      .from("listings")
      .update({
        listing_title: r.title.trim() || null,
        listing_description: r.description.trim() || null,
        // US-1568: a bulk-edit save is a human review — the draft leaves the
        // AutoLister needs-review queue.
        reviewed_at: new Date().toISOString(),
        listing_price: Number.isFinite(price) ? price : 0,
        ebay_condition: r.condition || null,
        quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
        best_offer_enabled: r.bestOffer,
        // US-562 / US-2405: persist thresholds as cents; a blank field stores
        // NULL, which means "no auto-clear" rather than "pick one for me".
        best_offer_auto_accept_cents: dollarsToCentsOrNull(r.bestOfferAccept),
        best_offer_auto_decline_cents: dollarsToCentsOrNull(r.bestOfferDecline),
        scheduled_publish_at: localInputToIso(r.scheduledAt),
        platform_category_id: r.categoryId.trim() || null,
        item_specifics_override:
          Object.keys(mergedSpecifics).length > 0 ? mergedSpecifics : null,
        item_specifics_sources: prunedSources,
        shipping_policy_id: r.shippingPolicyId || null,
        payment_policy_id: r.paymentPolicyId || null,
        return_policy_id: r.returnPolicyId || null,
        price_is_estimated: false,
      } as never)
      .eq("id", r.id);
    if (upErr) throw upErr;

    // Reverse-sync shared fields (single-entry rule, same helper the composer
    // save uses): a manual Brand/Size/Color flows back to its item column and
    // Department into the canonical attributes, so the seller never re-enters
    // them on the item page — and the next column re-assert can't undo them.
    const attrs = itemAttrs[r.itemId];
    if (attrs) {
      const wb = reverseProjectAspectColumns(
        {
          title: null,
          brand: attrs.brand || null,
          size: attrs.size || null,
          color: attrs.color || null,
          material: attrs.material || null,
          style: attrs.style || null,
          description: null,
          condition_notes: null,
          item_category: attrs.itemCategory,
          attributes: attrs.attributes,
        },
        mergedSpecifics,
        prunedSources,
      );
      const patch: Record<string, unknown> = { ...wb.columns };
      if (Object.keys(wb.attributes).length > 0) {
        patch.attributes = { ...(attrs.attributes ?? {}), ...wb.attributes };
      }
      if (Object.keys(patch).length > 0) {
        const { error: wbErr } = await supabase
          .from("inventory_items")
          .update(patch as never)
          .eq("id", r.itemId);
        if (wbErr) throw wbErr;

        // US-1995: the item's Brand/Size/Color/Style just changed, so the
        // listing TITLE has to follow — otherwise a seller who bulk-corrects a
        // brand across 40 drafts gets 40 titles still naming the old one, in
        // the single field buyers search hardest. US-1891 shipped this for the
        // item canvas and never for here.
        //
        // Same orchestration the canvas uses (buildTitleSyncPatch): eBay-origin
        // listings are refused, both A/B variants move, and a hand-edited title
        // is flagged for review rather than silently rewritten.
        const titleChanges = changesFromItemDiff(
          {
            brand: attrs.brand ?? null,
            size: attrs.size ?? null,
            color: attrs.color ?? null,
            style: attrs.style ?? null,
            department: (attrs.attributes?.Department as string | undefined) ?? null,
          },
          {
            brand: (wb.columns.brand as string | null | undefined) ?? attrs.brand ?? null,
            size: (wb.columns.size as string | null | undefined) ?? attrs.size ?? null,
            color: (wb.columns.color as string | null | undefined) ?? attrs.color ?? null,
            style: (wb.columns.style as string | null | undefined) ?? attrs.style ?? null,
            department:
              (wb.attributes?.Department as string | undefined) ??
              (attrs.attributes?.Department as string | undefined) ??
              null,
          },
        );
        const titlePatch = buildTitleSyncPatch({
          baseTitle: r.title,
          variants: r.titleVariants,
          changes: titleChanges,
          snapshotTitle: r.ai?.title ?? null,
          listingOrigin: r.listingOrigin,
        });
        if (Object.keys(titlePatch).length > 0) {
          const { error: tErr } = await supabase
            .from("listings")
            .update(titlePatch as never)
            .eq("id", r.id);
          if (tErr) throw tErr;
        }
      }
    }
  }

  async function saveAll() {
    const dirty = rows.filter((r) => r.dirty);
    if (dirty.length === 0) {
      toast.info("No changes to save.");
      return;
    }
    setSaving(true);
    // US-557: persist each dirty row INDEPENDENTLY. A single row's failure must
    // never discard the edits on the others — we settle every row, mark only the
    // ones that actually saved as clean, and leave the failed rows dirty so the
    // seller can fix and retry them. No blanket roll-back of in-progress work.
    const succeeded = new Set<string>();
    const failures: { id: string; message: string }[] = [];
    try {
      const CONCURRENCY = 5;
      for (let i = 0; i < dirty.length; i += CONCURRENCY) {
        const chunk = dirty.slice(i, i + CONCURRENCY);
        const results = await Promise.allSettled(chunk.map((r) => saveRow(r)));
        results.forEach((res, j) => {
          const row = chunk[j]!;
          if (res.status === "fulfilled") {
            succeeded.add(row.id);
          } else {
            const reason = res.reason;
            failures.push({
              id: row.id,
              message:
                reason instanceof Error ? reason.message : String(reason),
            });
          }
        });
      }
      // Clear the dirty flag ONLY on the rows that committed; failed rows keep
      // their edits (still dirty) for a retry.
      if (succeeded.size > 0) {
        setRows((prev) =>
          prev.map((r) => (succeeded.has(r.id) ? { ...r, dirty: false } : r)),
        );
      }
      if (failures.length === 0) {
        // Everything saved — safe to refetch the server's truth. items_full +
        // the attrs cache refresh too, since the reverse-sync may have updated
        // item columns/attributes.
        await qc.invalidateQueries({
          queryKey: ["autolister_batch_drafts", batchId],
        });
        await qc.invalidateQueries({ queryKey: ["items_full"] });
        await qc.invalidateQueries({
          queryKey: ["autolister_bulk_item_attrs", batchId],
        });
        toast.success(
          `Saved ${succeeded.size} listing${succeeded.size === 1 ? "" : "s"}.`,
        );
      } else {
        // Partial failure: do NOT invalidate — a refetch would overwrite the
        // still-dirty failed rows with the server's stale copy and lose edits.
        const savedMsg =
          succeeded.size > 0 ? `Saved ${succeeded.size}. ` : "";
        toast.error(
          `${savedMsg}${failures.length} listing${
            failures.length === 1 ? "" : "s"
          } couldn't save and stay marked unsaved: ${failures[0]!.message}`,
        );
      }
    } finally {
      setSaving(false);
    }
  }

  // US-320: real publish-blocker checks via /listings/validate. Bounded
  // concurrency so a 100-row batch doesn't hammer the edge service. Save
  // dirty rows first so the server validates the latest edits.
  async function validateRows(targetRows: EditRow[]) {
    if (targetRows.length === 0) {
      toast.info("Select rows to validate (or save edits first).");
      return;
    }
    if (rows.some((r) => r.dirty)) {
      toast.warning("Save your edits before validating — the server reads from the listing row.");
      return;
    }
    setValidating(true);
    try {
      const CONCURRENCY = 4;
      let ok = 0;
      let blocked = 0;
      for (let i = 0; i < targetRows.length; i += CONCURRENCY) {
        const batch = targetRows.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map(async (row) => {
            try {
              const res = await edgeFetch("/api/flipdesk/ebay/listings/validate", {
                method: "POST",
                json: { inventory_item_id: row.itemId },
              });
              const json = await res.json().catch(() => ({}));
              const blockers = Array.isArray(json.blockers)
                ? (json.blockers as string[])
                : [];
              return { id: row.id, blockers };
            } catch (err) {
              return {
                id: row.id,
                blockers: [
                  err instanceof Error ? err.message : "Validation request failed.",
                ],
              };
            }
          }),
        );
        setRows((prev) =>
          prev.map((r) => {
            const hit = results.find((x) => x.id === r.id);
            return hit ? { ...r, validationBlockers: hit.blockers } : r;
          }),
        );
        for (const r of results) {
          if (r.blockers.length === 0) ok++;
          else blocked++;
        }
      }
      toast.success(`Validated ${targetRows.length} — ${ok} clean, ${blocked} blocked.`);
    } finally {
      setValidating(false);
    }
  }

  function rowIssues(r: EditRow): string[] {
    const issues: string[] = [];
    if (!r.title.trim()) issues.push("Title is empty");
    else if (r.title.length > TITLE_MAX) issues.push(`Title over ${TITLE_MAX} chars`);
    const price = Number.parseFloat(r.price);
    if (!Number.isFinite(price) || price <= 0) issues.push("Price not set");
    if (!r.condition) issues.push("No condition");
    if (!r.categoryId.trim()) issues.push("No category");
    // US-555: aspect cascade — once a category's required specifics are known
    // (refreshed on bulk-category apply), flag rows that don't cover them.
    const required = requiredAspectsByCategory[r.categoryId];
    if (required && required.length > 0) {
      const covers = (name: string): boolean => {
        if (name === "Department") return !!r.department.trim();
        if (name === "Brand") return !!r.brand.trim();
        if (name === "Size") return !!r.size.trim();
        if (name === "Color") return !!r.color.trim();
        const v = r.specifics[name];
        return Array.isArray(v) && v.some((x) => x.trim());
      };
      const missing = required.filter((n) => !covers(n));
      if (missing.length > 0) issues.push(`Missing required: ${missing.join(", ")}`);
    }
    // Server-side blockers from /listings/validate take precedence — they
    // reflect missing required aspects, etc., that the local heuristics can't see.
    if (r.validationBlockers && r.validationBlockers.length > 0) {
      issues.push(...r.validationBlockers);
    }
    return issues;
  }

  // US-416: virtualize the grid body so a 1k+ row batch scrolls smoothly. The
  // Card is the scroll container; rows mount only when near the viewport. Hooks
  // must run before the early returns below, so this lives here.
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 10,
  });

  if (!batchId) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        No batch specified.{" "}
        <Link to="/dashboard/flipdesk/autolister" className="text-primary underline">
          Start a new batch
        </Link>
        .
      </div>
    );
  }

  if (isLoading) {
    return (
      <LoadingRegion label="Loading drafts" className="space-y-4 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </LoadingRegion>
    );
  }

  if (error) {
    return (
      <div className="py-12 text-center text-sm text-destructive">
        {error instanceof Error ? error.message : "Could not load drafts."}
      </div>
    );
  }

  const allSelected = rows.length > 0 && selected.size === rows.length;

  // Padding-row virtualization: spacer <tr>s above/below the rendered window
  // keep the <table> layout (and the sticky <thead>) intact while only the
  // on-screen rows mount.
  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();
  const paddingTop = virtualRows.length > 0 ? virtualRows[0]!.start : 0;
  const paddingBottom =
    virtualRows.length > 0
      ? totalSize - virtualRows[virtualRows.length - 1]!.end
      : 0;

  return (
    <div className="space-y-4">
      {/* US-2520: same batch, three screens, one nav. */}
      <BatchNav batchId={batchId} current="bulk-edit" />
      <PageHeader
        title="Bulk edit drafts"
        subtitle={
          <>
            {rows.length} draft{rows.length === 1 ? "" : "s"} in this batch. Edit
            inline or apply changes to selected rows.
          </>
        }
        actions={
          <>
            <Button asChild variant="outline">
              <Link to={`/dashboard/flipdesk/autolister/queue?batch=${batchId}`}>
                Back to queue
                <ArrowRight className="ml-1 h-4 w-4" />
              </Link>
            </Button>
            <Button onClick={saveAll} disabled={saving || dirtyCount === 0}>
              {saving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              Save {dirtyCount > 0 ? `(${dirtyCount})` : ""}
            </Button>
          </>
        }
      />

      {/* Bulk-apply toolbar */}
      <Card className="flex flex-wrap items-end gap-4 p-3">
        <div className="text-xs text-muted-foreground">
          Applies to{" "}
          <strong>{selected.size > 0 ? `${selected.size} selected` : "all rows"}</strong>
        </div>
        <div className="flex items-end gap-1.5">
          <div>
            <label htmlFor="ale-markup-pct" className="mb-1 block text-[10px] uppercase text-muted-foreground">
              Price markup %
            </label>
            <Input
              id="ale-markup-pct"
              type="number"
              value={markupPct}
              onChange={(e) => setMarkupPct(e.target.value)}
              className="h-8 w-24"
              placeholder="e.g. 10"
            />
          </div>
          <Button size="sm" variant="secondary" onClick={applyMarkup}>
            Apply
          </Button>
          <Button size="sm" variant="secondary" onClick={applyRound99}>
            Round to .99
          </Button>
        </div>
        {/* US-553: price rules beyond markup/.99. */}
        <div className="flex items-end gap-1.5">
          <div>
            <label htmlFor="ale-median-discount" className="mb-1 block text-[10px] uppercase text-muted-foreground">
              Median comp −%
            </label>
            <Input
              id="ale-median-discount"
              type="number"
              value={medianDiscountPct}
              onChange={(e) => setMedianDiscountPct(e.target.value)}
              className="h-8 w-24"
              placeholder="e.g. 5"
            />
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={!medianDiscountPct}
            onClick={applyMedianComp}
          >
            Apply
          </Button>
        </div>
        <div className="flex items-end gap-1.5">
          <div>
            <label htmlFor="ale-margin-floor" className="mb-1 block text-[10px] uppercase text-muted-foreground">
              Floor at % margin
            </label>
            <Input
              id="ale-margin-floor"
              type="number"
              value={marginFloorPct}
              onChange={(e) => setMarginFloorPct(e.target.value)}
              className="h-8 w-24"
              placeholder="e.g. 30"
            />
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={!marginFloorPct}
            onClick={applyMarginFloor}
          >
            Apply
          </Button>
          <Button size="sm" variant="secondary" onClick={applyMatchRecommended}>
            Match recommended
          </Button>
        </div>
        <div className="flex items-end gap-1.5">
          <div>
            <label htmlFor="ale-condition" className="mb-1 block text-[10px] uppercase text-muted-foreground">
              Condition
            </label>
            <select
              id="ale-condition"
              value={bulkCondition}
              onChange={(e) => setBulkCondition(e.target.value)}
              className="h-8 w-44 rounded-md border border-input bg-transparent px-2 text-sm"
            >
              <option value="">Select…</option>
              {EBAY_CONDITION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={!bulkCondition}
            onClick={() => applyToTargets(() => ({ condition: bulkCondition }))}
          >
            Apply
          </Button>
        </div>
        <div className="flex items-end gap-1.5">
          <div>
            <label htmlFor="ale-quantity" className="mb-1 block text-[10px] uppercase text-muted-foreground">
              Quantity
            </label>
            <Input
              id="ale-quantity"
              type="number"
              min="1"
              value={bulkQty}
              onChange={(e) => setBulkQty(e.target.value)}
              className="h-8 w-20"
              placeholder="1"
            />
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={!bulkQty}
            onClick={() => applyToTargets(() => ({ quantity: bulkQty }))}
          >
            Apply
          </Button>
        </div>
        <div className="flex items-end gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => applyToTargets(() => ({ bestOffer: true }))}
          >
            Enable Best Offer
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => applyToTargets(() => ({ bestOffer: false }))}
          >
            Disable
          </Button>
        </div>
        <div className="flex items-end gap-1.5">
          <div>
            <label htmlFor="ale-schedule" className="mb-1 block text-[10px] uppercase text-muted-foreground">
              Schedule publish
            </label>
            <Input
              id="ale-schedule"
              type="datetime-local"
              value={bulkSchedule}
              onChange={(e) => setBulkSchedule(e.target.value)}
              className="h-8 w-52"
            />
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={!bulkSchedule}
            onClick={() => applyToTargets(() => ({ scheduledAt: bulkSchedule }))}
          >
            Apply
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => applyToTargets(() => ({ scheduledAt: "" }))}
          >
            Clear
          </Button>
        </div>
        <div className="flex items-end gap-1.5">
          <div>
            <label htmlFor="ale-category" className="mb-1 block text-[10px] uppercase text-muted-foreground">
              eBay category
            </label>
            <CategorySearchControl
              id="ale-category"
              categoryId={bulkCategory?.id ?? ""}
              categoryPath={bulkCategory?.path ?? ""}
              align="start"
              triggerClassName="w-56"
              onPick={(id, path) => setBulkCategory({ id, path })}
            />
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={!bulkCategory || bulkCatAspects.isFetching}
            onClick={applyBulkCategory}
          >
            {bulkCatAspects.isFetching ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : null}
            Apply
          </Button>
        </div>
        <div className="flex items-end gap-1.5">
          <div>
            <label htmlFor="ale-department" className="mb-1 block text-[10px] uppercase text-muted-foreground">
              Department
            </label>
            <select
              id="ale-department"
              value={bulkDepartment}
              onChange={(e) => setBulkDepartment(e.target.value)}
              className="h-8 w-36 rounded-md border border-input bg-transparent px-2 text-sm"
            >
              <option value="">Select…</option>
              {EBAY_DEPARTMENT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={!bulkDepartment}
            onClick={() => applyToTargets(() => ({ department: bulkDepartment }))}
          >
            Apply
          </Button>
        </div>
        <div className="flex items-end gap-1.5">
          <div>
            <label htmlFor="ale-brand" className="mb-1 block text-[10px] uppercase text-muted-foreground">
              Brand
            </label>
            <Input
              id="ale-brand"
              value={bulkBrand}
              onChange={(e) => setBulkBrand(e.target.value)}
              className="h-8 w-32"
              placeholder="e.g. Nike"
            />
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={!bulkBrand.trim()}
            onClick={() => applyToTargets(() => ({ brand: bulkBrand.trim() }))}
          >
            Apply
          </Button>
        </div>

        {/* US-555: find/replace across titles + descriptions. */}
        <div className="flex items-end gap-1.5">
          <div>
            <label htmlFor="ale-find" className="mb-1 block text-[10px] uppercase text-muted-foreground">
              Find
            </label>
            <Input
              id="ale-find"
              value={findText}
              onChange={(e) => setFindText(e.target.value)}
              className="h-8 w-28"
              placeholder="text"
            />
          </div>
          <div>
            <label htmlFor="ale-replace" className="mb-1 block text-[10px] uppercase text-muted-foreground">
              Replace
            </label>
            <Input
              id="ale-replace"
              value={replaceText}
              onChange={(e) => setReplaceText(e.target.value)}
              className="h-8 w-28"
              placeholder="(blank to delete)"
            />
          </div>
          <select
            aria-label="Find and replace scope"
            value={findScope}
            onChange={(e) =>
              setFindScope(e.target.value as "title" | "description" | "both")
            }
            className="h-8 w-28 rounded-md border border-input bg-transparent px-2 text-sm"
          >
            <option value="title">Titles</option>
            <option value="description">Descriptions</option>
            <option value="both">Both</option>
          </select>
          <Button
            size="sm"
            variant="secondary"
            disabled={!findText}
            onClick={applyFindReplace}
          >
            <Replace className="mr-1.5 h-3.5 w-3.5" />
            Replace
          </Button>
        </div>

        {/* US-555: bulk business-policy assignment from the seller's eBay
            policies. Each select is optional — apply any subset. */}
        <div className="flex items-end gap-1.5">
          <div>
            <label htmlFor="ale-policy-shipping" className="mb-1 block text-[10px] uppercase text-muted-foreground">
              Shipping policy
            </label>
            <select
              id="ale-policy-shipping"
              value={bulkPolicy.fulfillment}
              onChange={(e) =>
                setBulkPolicy((p) => ({ ...p, fulfillment: e.target.value }))
              }
              className="h-8 w-40 rounded-md border border-input bg-transparent px-2 text-sm"
            >
              <option value="">Shipping…</option>
              {fulfillmentPolicies.map((p) => (
                <option key={p.policy_id} value={p.policy_id}>
                  {p.policy_name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="ale-policy-payment" className="mb-1 block text-[10px] uppercase text-muted-foreground">
              Payment policy
            </label>
            <select
              id="ale-policy-payment"
              value={bulkPolicy.payment}
              onChange={(e) =>
                setBulkPolicy((p) => ({ ...p, payment: e.target.value }))
              }
              className="h-8 w-40 rounded-md border border-input bg-transparent px-2 text-sm"
            >
              <option value="">Payment…</option>
              {paymentPolicies.map((p) => (
                <option key={p.policy_id} value={p.policy_id}>
                  {p.policy_name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="ale-policy-return" className="mb-1 block text-[10px] uppercase text-muted-foreground">
              Return policy
            </label>
            <select
              id="ale-policy-return"
              value={bulkPolicy.return}
              onChange={(e) =>
                setBulkPolicy((p) => ({ ...p, return: e.target.value }))
              }
              className="h-8 w-40 rounded-md border border-input bg-transparent px-2 text-sm"
            >
              <option value="">Return…</option>
              {returnPolicies.map((p) => (
                <option key={p.policy_id} value={p.policy_id}>
                  {p.policy_name}
                </option>
              ))}
            </select>
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={
              !bulkPolicy.fulfillment && !bulkPolicy.payment && !bulkPolicy.return
            }
            onClick={applyPolicies}
          >
            Assign policies
          </Button>
        </div>

        {/* US-555: template apply, AI aspect-fill, and smart defaults. */}
        <div className="flex items-end gap-1.5">
          <div>
            <label htmlFor="ale-template" className="mb-1 block text-[10px] uppercase text-muted-foreground">
              Template
            </label>
            <select
              id="ale-template"
              value={selectedTemplateId}
              onChange={(e) => setSelectedTemplateId(e.target.value)}
              className="h-8 w-44 rounded-md border border-input bg-transparent px-2 text-sm"
            >
              <option value="">Select template…</option>
              {(templatesQuery.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.is_default ? " (default)" : ""}
                </option>
              ))}
            </select>
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={!selectedTemplateId}
            onClick={applyTemplate}
          >
            <LayoutTemplate className="mr-1.5 h-3.5 w-3.5" />
            Apply
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={applyingDefaults}
            onClick={() => void applySmartDefaults()}
          >
            {applyingDefaults ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : null}
            Smart defaults
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={aiFilling}
            onClick={() => void aiFillSpecifics()}
          >
            {aiFilling ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Wand2 className="mr-1.5 h-3.5 w-3.5" />
            )}
            AI fill specifics
          </Button>
        </div>

        <div className="flex items-end gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            disabled={validating}
            onClick={() => {
              const target = selected.size > 0
                ? rows.filter((r) => selected.has(r.id))
                : rows;
              void validateRows(target);
            }}
          >
            {validating ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
            )}
            Validate {selected.size > 0 ? `(${selected.size})` : "all"}
          </Button>
        </div>
      </Card>

      {/* Grid — virtualized (US-416). The scroll container owns both axes so the
          sticky header and bounded height drive the row virtualizer. */}
      <div
        ref={scrollRef}
        className="max-h-[70dvh] overflow-auto rounded-xl border bg-card shadow-sm"
      >
        <table className="w-full text-sm">
          <thead className="border-b text-left text-xs uppercase text-muted-foreground [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-muted">
            <tr>
              <th className="w-8 p-2">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked ? new Set(rows.map((r) => r.id)) : new Set(),
                    )
                  }
                  aria-label="Select all"
                />
              </th>
              <th className="p-2">Title</th>
              <th className="w-44 p-2">Description</th>
              <th className="w-28 p-2">Price</th>
              <th className="w-32 p-2">Net / margin</th>
              <th className="w-44 p-2">Condition</th>
              <th className="w-48 p-2">Category</th>
              <th className="w-36 p-2">Department</th>
              <th className="w-28 p-2">Brand</th>
              <th className="w-24 p-2">Size</th>
              <th className="w-28 p-2">Color</th>
              <th className="w-32 p-2">Specifics</th>
              <th className="w-16 p-2">Qty</th>
              <th className="w-20 p-2">Best Offer</th>
              <th className="w-52 p-2">Schedule</th>
              <th className="w-24 p-2">Policies</th>
              <th className="w-10 p-2" />
            </tr>
          </thead>
          <tbody>
            {paddingTop > 0 && (
              <tr aria-hidden="true">
                <td colSpan={17} style={{ height: paddingTop }} />
              </tr>
            )}
            {virtualRows.map((vr) => {
              const r = rows[vr.index];
              if (!r) return null;
              const issues = rowIssues(r);
              // US-2450, same defect one table along. Every control below used
              // to carry a fixed name - "Select row", "Title", "Price" - so a
              // screen reader user moving down a column heard the same word on
              // every one of up to a few hundred virtualized rows with nothing
              // saying which garment. A name that does not distinguish is not a
              // usable name; the listings table was fixed for exactly this and
              // this table was left.
              //
              // Derived ONCE per row and threaded into every control, so the
              // row cannot introduce itself one way to the checkbox and another
              // way to the price field.
              //
              // The precedence mirrors what the cells SHOW: r.title is the
              // value the inputs render and the item's own title is only their
              // placeholder, so the edited title is item_title here and the
              // stored one is the fallback. Getting that backwards would make a
              // row announce a name it is not displaying, which is the second
              // half of the bug the listings table had.
              const rowItem = {
                item_title: r.title,
                listing_title: itemAttrs[r.itemId]?.title ?? null,
                id: r.id,
              };
              return (
                <tr
                  key={r.id}
                  data-index={vr.index}
                  ref={rowVirtualizer.measureElement}
                  className="border-b last:border-0 align-top"
                >
                  <td className="p-2">
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={(e) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(r.id);
                          else next.delete(r.id);
                          return next;
                        })
                      }
                      aria-label={`Select ${itemRowLabel(rowItem)}`}
                    />
                  </td>
                  <td className="p-2">
                    <Input aria-label={rowControlLabel("Title", rowItem)}
                      value={r.title}
                      onChange={(e) => patchRow(r.id, { title: e.target.value })}
                      placeholder={itemAttrs[r.itemId]?.title ?? "Title"}
                      className={cn(
                        "h-8",
                        r.title.length > TITLE_MAX && "border-destructive",
                      )}
                    />
                    <span
                      className={cn(
                        "text-[10px]",
                        r.title.length > TITLE_MAX
                          ? "text-destructive"
                          : "text-muted-foreground",
                      )}
                    >
                      {r.title.length}/{TITLE_MAX}
                    </span>
                    {r.ai && (
                      <AiDiffChip
                        changed={textChanged(r.ai.title, r.title)}
                        aiDisplay={r.ai.title ?? ""}
                        onRevert={() =>
                          patchRow(r.id, {
                            title: (r.ai?.title ?? "").slice(0, TITLE_MAX),
                          })
                        }
                        className="mt-1"
                      />
                    )}
                  </td>
                  {/* US-556: description editable inline via an expandable
                      popover; revert-to-AI mirrors the composer. */}
                  <td className="p-2">
                    <DescriptionCell
                      value={r.description}
                      aiDescription={r.ai?.description ?? null}
                      onChange={(v) => patchRow(r.id, { description: v })}
                    />
                  </td>
                  <td className="p-2">
                    <Input aria-label={rowControlLabel("Price", rowItem)}
                      type="number"
                      min="0"
                      step="0.01"
                      value={r.price}
                      onChange={(e) => patchRow(r.id, { price: e.target.value })}
                      className="h-8"
                      placeholder="0.00"
                    />
                    {r.ai && (
                      <AiDiffChip
                        changed={priceChanged(r.ai.price_cents, r.price)}
                        aiDisplay={formatAiPrice(r.ai.price_cents)}
                        onRevert={() =>
                          patchRow(r.id, { price: aiPriceInput(r.ai?.price_cents) })
                        }
                        className="mt-1"
                      />
                    )}
                  </td>
                  {/* US-553: forward net $ / margin %, live as price changes. */}
                  <td className="p-2">
                    <PnlCell
                      price={r.price}
                      cost={itemAttrs[r.itemId]?.cost ?? null}
                    />
                  </td>
                  <td className="p-2">
                    <select
                      aria-label={rowControlLabel("Condition", rowItem)}
                      value={r.condition}
                      onChange={(e) => patchRow(r.id, { condition: e.target.value })}
                      className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                    >
                      <option value="">—</option>
                      {EBAY_CONDITION_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    {r.ai && (
                      <AiDiffChip
                        changed={textChanged(r.ai.ebay_condition, r.condition)}
                        aiDisplay={conditionLabel(r.ai.ebay_condition)}
                        onRevert={() =>
                          patchRow(r.id, { condition: r.ai?.ebay_condition ?? "" })
                        }
                        className="mt-1"
                      />
                    )}
                  </td>
                  <td className="p-2">
                    <CategorySearchControl
                      categoryId={r.categoryId}
                      categoryPath={r.categoryPath}
                      triggerClassName="w-full"
                      onPick={(id, path) =>
                        patchRow(r.id, { categoryId: id, categoryPath: path })
                      }
                      onClear={() =>
                        patchRow(r.id, { categoryId: "", categoryPath: "" })
                      }
                    />
                  </td>
                  <td className="p-2">
                    <select
                      aria-label={rowControlLabel("Department", rowItem)}
                      value={r.department}
                      onChange={(e) => patchRow(r.id, { department: e.target.value })}
                      className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                    >
                      <option value="">—</option>
                      {EBAY_DEPARTMENT_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    {r.ai && (
                      <AiDiffChip
                        changed={textChanged(aiAspect(r.ai, "Department"), r.department)}
                        aiDisplay={aiAspect(r.ai, "Department")}
                        onRevert={() =>
                          patchRow(r.id, { department: aiAspect(r.ai, "Department") })
                        }
                        className="mt-1"
                      />
                    )}
                  </td>
                  <td className="p-2">
                    <Input aria-label={rowControlLabel("Brand", rowItem)}
                      value={r.brand}
                      onChange={(e) => patchRow(r.id, { brand: e.target.value })}
                      className="h-8"
                      placeholder={itemAttrs[r.itemId]?.brand || "—"}
                    />
                    {r.ai && (
                      <AiDiffChip
                        changed={textChanged(aiAspect(r.ai, "Brand"), r.brand)}
                        aiDisplay={aiAspect(r.ai, "Brand")}
                        onRevert={() =>
                          patchRow(r.id, { brand: aiAspect(r.ai, "Brand") })
                        }
                        className="mt-1"
                      />
                    )}
                  </td>
                  <td className="p-2">
                    <Input aria-label={rowControlLabel("Size", rowItem)}
                      value={r.size}
                      onChange={(e) => patchRow(r.id, { size: e.target.value })}
                      className="h-8"
                      placeholder={itemAttrs[r.itemId]?.size || "—"}
                    />
                    {r.ai && (
                      <AiDiffChip
                        changed={textChanged(aiAspect(r.ai, "Size"), r.size)}
                        aiDisplay={aiAspect(r.ai, "Size")}
                        onRevert={() =>
                          patchRow(r.id, { size: aiAspect(r.ai, "Size") })
                        }
                        className="mt-1"
                      />
                    )}
                  </td>
                  <td className="p-2">
                    <Input aria-label={rowControlLabel("Color", rowItem)}
                      value={r.color}
                      onChange={(e) => patchRow(r.id, { color: e.target.value })}
                      className="h-8"
                      placeholder={itemAttrs[r.itemId]?.color || "—"}
                    />
                    {r.ai && (
                      <AiDiffChip
                        changed={textChanged(aiAspect(r.ai, "Color"), r.color)}
                        aiDisplay={aiAspect(r.ai, "Color")}
                        onRevert={() =>
                          patchRow(r.id, { color: aiAspect(r.ai, "Color") })
                        }
                        className="mt-1"
                      />
                    )}
                  </td>
                  {/* US-556: arbitrary item specifics (beyond the dedicated
                      Department/Brand/Size/Color columns) editable inline. */}
                  <td className="p-2">
                    <SpecificsCell
                      specifics={r.specifics}
                      requiredNames={(
                        requiredAspectsByCategory[r.categoryId] ?? []
                      ).filter(
                        (n) => !DEDICATED_ASPECTS.includes(n),
                      )}
                      onChange={(next) => patchRow(r.id, { specifics: next })}
                    />
                  </td>
                  <td className="p-2">
                    <Input aria-label={rowControlLabel("Quantity", rowItem)}
                      type="number"
                      min="1"
                      value={r.quantity}
                      onChange={(e) => patchRow(r.id, { quantity: e.target.value })}
                      className="h-8"
                    />
                  </td>
                  {/* US-562 / US-2405: Best Offer toggle + per-item
                      auto-accept/decline thresholds. Blank means NO threshold —
                      the offer waits for the seller. There is no comp-derived
                      default any more; see best-offer.ts for why. */}
                  <td className="p-2 text-center align-top">
                    <input
                      type="checkbox"
                      checked={r.bestOffer}
                      onChange={(e) => patchRow(r.id, { bestOffer: e.target.checked })}
                      aria-label={rowControlLabel("Best offer", rowItem)}
                    />
                    {r.bestOffer && (
                      <div className="mt-1 flex flex-col gap-1">
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={r.bestOfferAccept}
                          onChange={(e) =>
                            patchRow(r.id, { bestOfferAccept: e.target.value })
                          }
                          placeholder="Auto-accept ≥"
                          title="Auto-accept offers at or above this price. Blank = review every offer yourself."
                          aria-label={rowControlLabel("Best offer auto-accept price", rowItem)}
                          className="h-7 w-24 text-xs"
                        />
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={r.bestOfferDecline}
                          onChange={(e) =>
                            patchRow(r.id, { bestOfferDecline: e.target.value })
                          }
                          placeholder="Auto-decline ≤"
                          title="Auto-decline offers at or below this price. Blank = review every offer yourself."
                          aria-label={rowControlLabel("Best offer auto-decline price", rowItem)}
                          className="h-7 w-24 text-xs"
                        />
                      </div>
                    )}
                  </td>
                  <td className="p-2">
                    <Input aria-label={rowControlLabel("Scheduled publish time", rowItem)}
                      type="datetime-local"
                      value={r.scheduledAt}
                      onChange={(e) => patchRow(r.id, { scheduledAt: e.target.value })}
                      className="h-8"
                    />
                  </td>
                  {/* US-555: per-listing policy override badges — S/P/R light up
                      when assigned; fall back to account defaults when blank. */}
                  <td className="p-2">
                    <PolicyBadges
                      shippingId={r.shippingPolicyId}
                      paymentId={r.paymentPolicyId}
                      returnId={r.returnPolicyId}
                      labels={policyLabel}
                    />
                  </td>
                  <td className="p-2">
                    {issues.length > 0 && (
                      <span title={issues.join(" • ")}>
                        <AlertTriangle className="h-4 w-4 text-amber-500" />
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {paddingBottom > 0 && (
              <tr aria-hidden="true">
                <td colSpan={17} style={{ height: paddingBottom }} />
              </tr>
            )}
            {rows.length === 0 && (
              <tr>
                <td colSpan={17} className="p-6 text-center text-sm text-muted-foreground">
                  No drafts in this batch.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// US-556: edit the listing description inline. The cell trigger shows a one-line
// snippet; the popover holds a full textarea. Writes the same `description`
// field the composer's textarea does, so it flows through the shared save path
// (listing_description) untouched. A revert-to-AI chip mirrors the composer when
// an AI snapshot exists.
// US-2520: DescriptionCell, SpecificsCell, PnlCell, PolicyBadges,
// useDebounced and CategorySearchControl moved to
// ./autolister/bulk-edit-cells.tsx — they are prop-only renderers and were
// the easy 400 lines of this file to stop carrying.
