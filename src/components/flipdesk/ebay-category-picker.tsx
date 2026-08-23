import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search, X, Check, AlertCircle, Sparkles } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  useAiExtractAspects,
  useEbayCategoryAspects,
  useEbayCategorySuggest,
  type EbayAspect,
  type EbayCategorySuggestion,
} from "@/hooks/use-ebay";
import { cn } from "@/lib/utils";
import type { ListingCategoryCandidate } from "@/types/database";
import {
  remapAspectsForCategory,
  syncedItemFieldFor,
  type AspectRemapResult,
  type AspectRewrite,
  type ItemAspectSource,
} from "@/lib/ebay-prefill";
import {
  PROVENANCE_BADGE,
  pruneSources,
  requiredMissingAspectNames,
  type AspectSourceMap,
  type StoredAspectProvenance,
} from "@/lib/aspect-provenance";
import {
  forceMeasurementAspects,
  measurementKeyForAspect,
  measurementLabel,
  measurementsNumericallyEqual,
  parseMeasurementAspectValue,
  type LengthUnit,
} from "@/lib/measurements";

interface Props {
  itemId: string;
  initialCategoryId: string | null;
  initialAspects: Record<string, string[]> | null;
  // US-825: per-aspect provenance for the saved values, so reopening a draft
  // shows the right source badges (AI / Auto / You) instead of guessing.
  initialAspectSources?: AspectSourceMap | null;
  // When set, the picker uses this as the default query on first mount —
  // typically the item's title so the user lands on a relevant suggestion.
  seedQuery?: string;
  // Structured item columns (brand, size, color, …). Any aspect still empty
  // after the saved values are applied is prefilled from these, so the user
  // isn't re-typing data the item already has. Pass a MEMOIZED object.
  itemFields?: ItemAspectSource | null;
  // Live Measurements section values — projected onto matching free-text eBay
  // aspects (and reverse-synced from manual aspect edits). Last-write-wins.
  measurements?: Record<string, number | string>;
  onMeasurementsChange?: (next: Record<string, number | string>) => void;
  measurementUnit?: LengthUnit;
  // Notifies the parent every time the user picks (or clears) a category, so
  // siblings can react before the save is committed. The breadcrumb path is
  // passed too (when known) so the composer can derive the coarse item_category
  // from the chosen eBay leaf (category coupling).
  onCategoryChange?: (
    categoryId: string | null,
    categoryPath?: string | null,
  ) => void;
  /**
   * US-2673: the breadcrumb currently in effect, whether the seller just picked
   * it or it was resolved from a saved draft's category id.
   *
   * Separate from `onCategoryChange` on purpose. That one means "the seller
   * changed the category" and a save acts on it, cascading the coarse
   * item_category; firing it for a reopened draft would make the page cascade
   * on load. This one only tells the parent what the category IS, which is what
   * the measurement template needs to key off.
   */
  onResolvedCategoryPath?: (categoryPath: string | null) => void;
  // US-557: surfaces the live aspect map to the parent on every edit. The
  // composer owns persistence now — there's ONE Save (the draft save) that
  // writes these aspects to both the listing override and the inventory mirror,
  // so picker edits can't vanish by skipping a separate "Save specifics" click.
  onAspectsChange?: (aspects: Record<string, string[]>) => void;
  // Fired the first time the SELLER changes something in here — a field edit,
  // a Clear, an AI fill, or picking a different category.
  //
  // The unsaved-changes guard needs this because `onAspectsChange` cannot
  // answer "did a human do that?". The picker rewrites `aspectValues` on its
  // own twice after mount — the deterministic remap once the category's aspect
  // spec arrives, and the Measurements → aspect projection — and both land
  // AFTER the composer has stamped its baseline from the first (unprefilled)
  // report. Inferring intent from report ORDER therefore marked every freshly
  // opened item dirty before anyone touched it, so the composer prompted
  // "Leave without saving?" on the way out of a page the seller had only read.
  // A guard that fires on every exit is a guard nobody reads.
  onUserEdit?: () => void;
  // US-825: lift the live provenance map so the single Save persists it
  // alongside the aspect values (parallel jsonb).
  onSourcesChange?: (sources: AspectSourceMap) => void;
  // US-825: lift the names of required-but-unfilled aspects for the chosen
  // category so the composer's publish button can warn "N required specifics
  // missing" BEFORE calling publish (same rule the server blocker uses).
  onMissingRequiredChange?: (missing: string[]) => void;
  // US-828: aspect names flagged needs-review by generation-time reconciliation
  // (a value not in eBay's allowed set, or an invented aspect). The matching
  // rows are highlighted so the seller fixes them before they drop at publish.
  needsReviewAspects?: string[] | null;
  // US-2426: the leaves AutoLister weighed at generation time (US-2424), ranked
  // best-first with element 0 the one it chose. Already scored and already on
  // the draft, so showing them costs no AI and no Taxonomy call. Null/empty on
  // any draft that never went through the scorer — an item that already had a
  // category, an eBay-origin mirror, or a draft generated before migration
  // 00540 — and the block simply doesn't render.
  categoryCandidates?: ListingCategoryCandidate[] | null;
}

/**
 * The next value array for an aspect, given what the CONTROL meant.
 *
 * `intent` is not the aspect's cardinality, and conflating the two is the bug
 * this exists to prevent. Toggling is only right for the chip row
 * (SELECTION_ONLY + MULTI); a text box and a dropdown always REPLACE.
 *
 * Deciding on cardinality alone silently broke every MULTI **free-text** aspect
 * — on Women's Tops that is Material, Occasion, Accents, Theme, Features,
 * Character and MPN, each of which renders as a plain text box. Every keystroke
 * appended instead of replacing: clearing "Jersey" appended "" and left
 * `["Jersey", ""]`, and typing "Silk" gave `["Jersey", "S", "Si", …]`. The box
 * redisplays the stored value once the focus draft is dropped, so the seller
 * watched the field snap straight back — reported as "Material and Occasion
 * won't let me change or null out".
 */
export function nextAspectValues(
  existing: string[],
  value: string,
  opts: { intent: "toggle" | "set"; multi: boolean },
): string[] {
  if (opts.intent === "toggle") {
    return existing.includes(value)
      ? existing.filter((v) => v !== value)
      : [...existing, value];
  }
  if (opts.multi) {
    // eBay's own convention for a multi-value specific typed as text.
    return value
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  return value ? [value] : [];
}

// ── US-2426: the leaves AutoLister passed over ──────────────────────────────

/** How many runner-ups the block offers. Past three it is a taxonomy browser,
 *  and the search box below already is one. */
export const MAX_ALTERNATE_CANDIDATES = 3;

/**
 * The scored leaves worth offering right now: everything except the one that is
 * selected. Filtering on the CURRENT selection rather than on "element 0"
 * matters — after a switch, the list has to offer the way back, not the leaf the
 * seller is already sitting on.
 */
export function alternateCategoryCandidates(
  candidates: ListingCategoryCandidate[] | null | undefined,
  selectedCategoryId: string | null,
): ListingCategoryCandidate[] {
  return (candidates ?? [])
    .filter((c) => c.categoryId && c.categoryId !== selectedCategoryId)
    .slice(0, MAX_ALTERNATE_CANDIDATES);
}

/**
 * The runner-up rows. Presentational and exported so the render is testable
 * without standing up the whole picker (react-query, Taxonomy hooks, the aspect
 * grid). Renders NOTHING when there is nothing scored to offer — a draft that
 * never went through the US-2424 scorer must not get an empty block.
 */
export function CategoryCandidateList({
  candidates,
  onUse,
}: {
  candidates: ListingCategoryCandidate[];
  onUse: (categoryId: string, categoryPath: string | null) => void;
}) {
  if (candidates.length === 0) return null;
  return (
    <div className="border-t px-3 pb-3 pt-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Also considered
      </div>
      <ul className="mt-1 space-y-1">
        {candidates.map((c) => (
          <li key={c.categoryId} className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-xs font-medium">
                {c.categoryPath ?? `Category ${c.categoryId}`}
              </div>
              <div className="text-xs text-muted-foreground">
                {c.requiredTotal > 0 ? (
                  <>
                    Fills{" "}
                    <span className="tabular-nums">
                      {c.requiredFilled} of {c.requiredTotal}
                    </span>{" "}
                    required
                    {c.requiredMissing.length > 0 && (
                      <> · missing {c.requiredMissing.slice(0, 3).join(", ")}</>
                    )}
                  </>
                ) : (
                  "No required specifics"
                )}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={() => onUse(c.categoryId, c.categoryPath ?? null)}
              aria-label={`Use ${c.categoryPath ?? `category ${c.categoryId}`}`}
            >
              Use this
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// 250ms debounce — eBay's Taxonomy quota is generous but not free.
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

export function EbayCategoryPicker({
  itemId,
  initialCategoryId,
  initialAspects,
  initialAspectSources,
  seedQuery,
  itemFields,
  measurements,
  onMeasurementsChange,
  measurementUnit = "in",
  onCategoryChange,
  onResolvedCategoryPath,
  onAspectsChange,
  onUserEdit,
  onSourcesChange,
  onMissingRequiredChange,
  needsReviewAspects,
  categoryCandidates,
}: Props) {
  const [query, setQuery] = useState(seedQuery ?? "");
  const debounced = useDebounced(query.trim(), 250);

  const [categoryId, setCategoryId] = useState<string | null>(
    initialCategoryId
  );
  const [categoryPath, setCategoryPath] = useState<string | null>(null);
  // "Change category" mode: re-open the search over an already-chosen category
  // WITHOUT clearing it (or its specifics) first. Picking a new leaf applies it;
  // cancelling keeps the current one. This is how a seller re-categorizes a
  // draft (e.g. men's → women's) from the editor.
  const [changing, setChanging] = useState(false);

  // aspectValues: { [aspectName]: string[] }. We always store arrays so MULTI-
  // cardinality aspects fit the same shape. SINGLE aspects use a length-1 array.
  const [aspectValues, setAspectValues] = useState<Record<string, string[]>>(
    initialAspects ?? {}
  );

  // US-825: per-aspect provenance (ai_extracted | inventory_derived | manual).
  // Drives the source badges. Seeded from the saved sources; updated by AI fill,
  // deterministic derivation, and manual edits. `unfilled` is computed, not here.
  const [sources, setSources] = useState<AspectSourceMap>(
    initialAspectSources ?? {},
  );

  // Aspect names the AI most recently filled — drives the "AI" badge tooltip's
  // confidence (the badge itself now comes from `sources`).
  const [aiFilled, setAiFilled] = useState<Set<string>>(new Set());
  // Per-aspect confidence for the "AI" badge tooltip / styling.
  const [aiMeta, setAiMeta] = useState<
    Record<string, { confidence: number; source: string }>
  >({});
  // US-823: aspects whose prefilled value was normalized to eBay's allowed list
  // (e.g. "M" → "Medium") — drives the "sent as" hint under the field.
  const [prefillHints, setPrefillHints] = useState<
    Record<string, AspectRewrite>
  >({});

  // US-828: loose-keyed (case/punctuation-insensitive) set of aspect names the
  // generation reconciler flagged, so AspectField can highlight the matching
  // rows regardless of eBay's exact display casing.
  const needsReviewSet = useMemo(() => {
    const s = new Set<string>();
    for (const name of needsReviewAspects ?? []) {
      const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (key) s.add(key);
    }
    return s;
  }, [needsReviewAspects]);
  const isNeedsReview = (name: string): boolean =>
    needsReviewSet.has(name.toLowerCase().replace(/[^a-z0-9]/g, ""));

  const suggestQuery = useEbayCategorySuggest(debounced);
  const aspectsQuery = useEbayCategoryAspects(categoryId);
  const aiExtract = useAiExtractAspects();

  // The human-readable breadcrumb to show for the chosen category. When the
  // user picks a fresh suggestion we have the path immediately (`categoryPath`);
  // when a saved draft is reopened we only have the id, so fall back to the
  // breadcrumb the server resolves alongside the aspect spec — never show a raw
  // "Category 11554" when a real path is available.
  const displayCategoryPath = categoryPath ?? aspectsQuery.data?.categoryName ?? null;

  // US-2673: hand the breadcrumb to the parent so the measurement template can
  // key off the garment the category names. Reported on resolve as well as on
  // pick, because a reopened draft only ever has the id.
  const reportResolved = useRef(onResolvedCategoryPath);
  reportResolved.current = onResolvedCategoryPath;
  useEffect(() => {
    reportResolved.current?.(displayCategoryPath);
  }, [displayCategoryPath]);

  // US-557: keep the parent's lifted aspect state in lockstep with every edit
  // (manual, AI fill, category-change prune, prefill). The composer's single
  // Save reads this — no separate per-picker save to forget.
  useEffect(() => {
    onAspectsChange?.(aspectValues);
  }, [aspectValues, onAspectsChange]);

  // US-825: lift the live provenance map so the composer's single Save persists
  // it parallel to the aspect values.
  useEffect(() => {
    onSourcesChange?.(sources);
  }, [sources, onSourcesChange]);

  // US-824: deterministic, no-AI refill on category change. We read the live
  // aspect map / category path through refs so this effect depends only on the
  // fetched spec (and itemFields) — it must NOT re-run on every keystroke, or a
  // re-derive could re-add a value the user just cleared.
  const aspectValuesRef = useRef(aspectValues);
  useEffect(() => {
    aspectValuesRef.current = aspectValues;
  }, [aspectValues]);
  const sourcesRef = useRef(sources);
  useEffect(() => {
    sourcesRef.current = sources;
  }, [sources]);
  const categoryPathRef = useRef(categoryPath);
  useEffect(() => {
    categoryPathRef.current = categoryPath;
  }, [categoryPath]);
  // Live measurement ↔ aspect bridge: skip reverse write-back while we are
  // projecting Measurements → aspects so the lift echo cannot loop.
  const syncingFromMeasurementsRef = useRef(false);
  const measurementsRef = useRef(measurements);
  useEffect(() => {
    measurementsRef.current = measurements;
  }, [measurements]);

  // Remap must NOT re-fire on measurement-only churn (live sync owns that).
  // Columns / category / title still trigger a deterministic refill.
  const itemFieldsRemapKey = useMemo(() => {
    if (!itemFields) return "";
    return JSON.stringify({
      brand: itemFields.brand,
      size: itemFields.size,
      color: itemFields.color,
      material: itemFields.material,
      style: itemFields.style,
      title: itemFields.title,
      item_category: itemFields.item_category,
      attributes: itemFields.attributes,
    });
  }, [itemFields]);
  // The category whose spec is currently reflected in `aspectValues`. Starts at
  // the item's saved category so the first spec load is treated as initial
  // (no discard prompt), not as a user-initiated change.
  const appliedCategoryRef = useRef<string | null>(initialCategoryId);
  // Parked specifics: values dropped by a category change (no equivalent aspect
  // in the new category) are held here rather than lost, so switching to a
  // category that CAN hold them restores them. In-session only (a convenience
  // atop the confirm dialog). Keyed by their original aspect name.
  const parkedRef = useRef<Record<string, string[]>>({});
  const appliedCategoryPathRef = useRef<string | null>(null);
// US-824 originally held a category change behind a confirm when specifics
// would not carry over. Removed by owner decision, 2026-08-03: the dialog
// interrupted every re-categorisation to report something that is not a loss.
// Dropped values are PARKED, not destroyed — switch back, or pick a category
// that supports them, and they return. The change now applies immediately and
// says what it set aside in a toast, which is the honest weight for
// "these moved out of view" rather than "confirm before we delete your work".

  // Commit a remap result: keep still-valid values, carry re-homed (remapped)
  // values under their new aspect name, add the derived gap-fills, restore any
  // previously-parked values that now fit, re-park the rest, refresh hints, and
  // move AI markers.
  const commitRemap = (aspectList: EbayAspect[], result: AspectRemapResult) => {
    // Restore parked values that fit this category (pure, no AI), then re-park
    // whatever still has no home along with anything newly dropped.
    const restore = remapAspectsForCategory(parkedRef.current, aspectList, null);
    const restored = { ...restore.remapped, ...restore.kept };
    const consumed = new Set<string>([
      ...Object.keys(restore.kept),
      ...Object.values(restore.remappedFrom),
    ]);
    const nextParked: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(parkedRef.current)) {
      if (!consumed.has(k)) nextParked[k] = v;
    }
    for (const [k, v] of Object.entries(result.dropped)) nextParked[k] = v;
    parkedRef.current = nextParked;

    // Live kept/remapped/derived win over restored gap-fills.
    const nextValues = {
      ...restored,
      ...result.derived,
      ...result.remapped,
      ...result.kept,
    };
    setAspectValues(nextValues);
    // US-825: kept values keep their prior provenance; a remapped value carries
    // the provenance of its OLD aspect name; derived + restored gap-fills are
    // inventory_derived. Dropped aspects fall away with prune.
    setSources((prev) => {
      const next: AspectSourceMap = {};
      for (const k of Object.keys(result.kept)) {
        if (prev[k]) next[k] = prev[k];
      }
      for (const k of Object.keys(result.remapped)) {
        const from = result.remappedFrom[k];
        next[k] = from && prev[from] ? prev[from] : "inventory_derived";
      }
      for (const k of Object.keys(result.derived)) next[k] = "inventory_derived";
      for (const k of Object.keys(restored)) {
        if (!next[k]) next[k] = "inventory_derived";
      }
      return pruneSources(next, nextValues);
    });
    const valid = new Set(aspectList.map((a) => a.localizedAspectName));
    setPrefillHints((prev) => {
      const merged: Record<string, AspectRewrite> = {};
      for (const [k, v] of Object.entries(prev)) if (valid.has(k)) merged[k] = v;
      for (const [k, v] of Object.entries(result.rewrites)) merged[k] = v;
      return merged;
    });
    setAiFilled((prev) => {
      const next = new Set(prev);
      for (const n of Object.keys(result.dropped)) next.delete(n);
      // A re-homed AI value keeps its "AI-filled" badge under the new name.
      for (const [newName, oldName] of Object.entries(result.remappedFrom)) {
        if (next.has(oldName)) {
          next.delete(oldName);
          next.add(newName);
        }
      }
      return next;
    });
  };

  // When the user picks a different category, refetch its spec and refill
  // deterministically from data we already have (still-valid values + the
  // item's columns/US-821 attributes mapped through the registry) — zero AI.
  // A genuine change that would discard values is gated behind a confirm.
  // Measurement-only churn is excluded via itemFieldsRemapKey — live sync below
  // owns Measurements ↔ aspect projection.
  useEffect(() => {
    if (!aspectsQuery.data) return;
    const aspectList = aspectsQuery.data.aspects.aspects ?? [];
    const result = remapAspectsForCategory(
      aspectValuesRef.current,
      aspectList,
      itemFields ?? null,
    );
    // Same id we last applied ⇒ first load or a re-fetch (itemFields change),
    // not a user category switch. Only a real switch is worth reporting.
    const isInitial = appliedCategoryRef.current === categoryId;
    const droppedNames = Object.keys(result.dropped);
    if (!isInitial && droppedNames.length > 0) {
      const shown = droppedNames.slice(0, 3).join(", ");
      toast.info(
        `${droppedNames.length} item ${
          droppedNames.length === 1 ? "specific has" : "specifics have"
        } no match here: ${shown}${droppedNames.length > 3 ? "…" : ""}`,
        {
          description:
            "Set aside, not deleted — switch back or pick a category that supports them and they return.",
        },
      );
    }
    commitRemap(aspectList, result);
    appliedCategoryRef.current = categoryId;
    appliedCategoryPathRef.current = categoryPathRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aspectsQuery.data, itemFieldsRemapKey]);

  // Live Measurements → free-text eBay measurement aspects (last-write-wins).
  useEffect(() => {
    if (!onMeasurementsChange) return;
    if (!aspectsQuery.data) return;
    const aspectList = aspectsQuery.data.aspects.aspects ?? [];
    const categoryAspects: Record<string, string[]> = {};
    for (const a of aspectList) {
      const name = (a.localizedAspectName ?? "").trim();
      if (!name) continue;
      categoryAspects[name] =
        a.aspectConstraint?.aspectMode === "SELECTION_ONLY"
          ? (a.aspectValues ?? [])
              .map((v) => v.localizedValue ?? "")
              .filter((v) => v.length > 0)
          : [];
    }
    const { aspects: forced, cleared } = forceMeasurementAspects(
      measurements ?? {},
      categoryAspects,
      aspectValuesRef.current,
      measurementUnit,
      sourcesRef.current,
    );
    if (Object.keys(forced).length === 0 && cleared.length === 0) return;

    syncingFromMeasurementsRef.current = true;
    setAspectValues((prev) => {
      const next = { ...prev };
      for (const [name, values] of Object.entries(forced)) next[name] = values;
      for (const name of cleared) delete next[name];
      return next;
    });
    setSources((prev) => {
      const next = { ...prev };
      for (const name of Object.keys(forced)) next[name] = "inventory_derived";
      for (const name of cleared) delete next[name];
      return next;
    });
    // Release the guard after React flushes the aspect lift effects.
    queueMicrotask(() => {
      syncingFromMeasurementsRef.current = false;
    });
  }, [
    measurements,
    measurementUnit,
    aspectsQuery.data,
    onMeasurementsChange,
  ]);
  const aspects: EbayAspect[] = useMemo(
    () => aspectsQuery.data?.aspects.aspects ?? [],
    [aspectsQuery.data]
  );

  const required = useMemo(
    () => aspects.filter((a) => a.aspectConstraint.aspectRequired),
    [aspects]
  );
  const recommended = useMemo(
    () =>
      aspects.filter(
        (a) =>
          !a.aspectConstraint.aspectRequired &&
          a.aspectConstraint.aspectUsage === "RECOMMENDED"
      ),
    [aspects]
  );
  const optional = useMemo(
    () =>
      aspects.filter(
        (a) =>
          !a.aspectConstraint.aspectRequired &&
          a.aspectConstraint.aspectUsage !== "RECOMMENDED"
      ),
    [aspects]
  );

  // US-825: required-but-unfilled, computed with the SAME helper the server's
  // publish blocker uses, so the pre-publish checklist and the blocker agree.
  const missingRequiredNames = useMemo(
    () => requiredMissingAspectNames(aspects, aspectValues),
    [aspects, aspectValues],
  );
  const missingRequired = required.filter(
    (a) => !aspectValues[a.localizedAspectName]?.length
  );

  // Lift the missing-required names so the composer's publish button can warn
  // inline before calling publish. Depend on a stable joined key (the names
  // array gets a fresh identity each render) but lift the real array. Newline
  // is a safe delimiter — eBay aspect names never contain one.
  // US-2426: the scored leaves AutoLister passed over, minus whichever one is
  // selected right now.
  const alternateCandidates = useMemo(
    () => alternateCategoryCandidates(categoryCandidates, categoryId),
    [categoryCandidates, categoryId],
  );
  // The score for the leaf currently selected, when the scorer saw it. Shown
  // beside the alternatives so "5 of 6" means something to compare against.
  const selectedCandidate = useMemo(
    () => (categoryCandidates ?? []).find((c) => c.categoryId === categoryId) ?? null,
    [categoryCandidates, categoryId],
  );

  const missingKey = missingRequiredNames.join("\n");
  useEffect(() => {
    onMissingRequiredChange?.(missingRequiredNames);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingKey, onMissingRequiredChange]);

  // Applying a category NEVER clears the aspect values. The picker prunes them
  // against the new spec once it loads (appliedCategoryRef), so a specific the
  // new leaf also has survives the switch — which is the whole point of the
  // "Change category" flow and, since US-2426, of the runner-up switch too.
  // Every entry point below is reached only by a click or a keystroke, which is
  // exactly the property the dirty guard needs and the one `aspectValues` alone
  // cannot supply. Keep it that way: never call onUserEdit from an effect.
  function applyCategory(id: string, path: string | null) {
    onUserEdit?.();
    setCategoryId(id);
    setCategoryPath(path);
    setQuery("");
    setChanging(false);
    onCategoryChange?.(id, path);
  }

  function pickCategory(s: EbayCategorySuggestion) {
    applyCategory(s.categoryId, s.categoryTreePath);
  }

  function clearCategory() {
    onUserEdit?.();
    setCategoryId(null);
    setCategoryPath(null);
    setAspectValues({});
    setSources({});
    setAiFilled(new Set());
    setAiMeta({});
    setPrefillHints({});
    appliedCategoryRef.current = null;
    appliedCategoryPathRef.current = null;
    onCategoryChange?.(null, null);
  }

  function setAspect(
    name: string,
    value: string,
    opts: { intent: "toggle" | "set"; multi: boolean },
  ) {
    onUserEdit?.();
    // Compute the resulting value array so provenance can track whether the
    // aspect is now filled (manual) or cleared (drop the source entry).
    const nextArr = nextAspectValues(aspectValues[name] ?? [], value, opts);
    setAspectValues((prev) => ({ ...prev, [name]: nextArr }));
    // US-825: a manual edit is `manual` provenance; a cleared field drops out.
    setSources((prev) => {
      const next = { ...prev };
      if (nextArr.length > 0) next[name] = "manual";
      else delete next[name];
      return next;
    });
    // A manual edit clears the AI marker for that aspect.
    setAiFilled((prev) => {
      if (!prev.has(name)) return prev;
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
    // …and the prefill "sent as" hint — the value is now the user's own.
    setPrefillHints((prev) => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });

    // Reverse: free-text measurement aspects → Measurements section.
    if (syncingFromMeasurementsRef.current || !onMeasurementsChange) return;
    const measKey = measurementKeyForAspect(name);
    if (!measKey) return;
    // Skip SELECTION_ONLY (style dropdowns like "Short Sleeve").
    const aspectMeta = (aspectsQuery.data?.aspects.aspects ?? []).find(
      (a) => a.localizedAspectName === name,
    );
    if (aspectMeta?.aspectConstraint?.aspectMode === "SELECTION_ONLY") return;

    const raw = nextArr[0]?.trim() ?? "";
    const currentMeas = measurementsRef.current ?? {};
    if (!raw) {
      if (!(measKey in currentMeas)) return;
      const next = { ...currentMeas };
      delete next[measKey];
      onMeasurementsChange(next);
      return;
    }
    const parsed = parseMeasurementAspectValue(measKey, raw);
    if (parsed == null) return;
    if (measurementsNumericallyEqual(currentMeas[measKey], parsed)) return;
    onMeasurementsChange({ ...currentMeas, [measKey]: parsed });
  }

  async function handleAiFill() {
    if (!categoryId) {
      toast.error("Pick an eBay category first.");
      return;
    }
    try {
      const result = await aiExtract.mutateAsync({
        itemId,
        categoryId,
        categoryPath: categoryPath ?? undefined,
        knownAspects: aspectValues,
      });
      // Merge: AI suggestions only fill empty aspects (or replace AI-filled
      // ones); never clobber a manual edit. The known_aspects payload tells
      // the server not to suggest those at all, but we double-check here.
      let added = 0;
      const nextValues = { ...aspectValues };
      const nextAi = new Set(aiFilled);
      const nextMeta = { ...aiMeta };
      const nextSources: AspectSourceMap = { ...sources };
      for (const [name, sug] of Object.entries(result.suggestions)) {
        const currentlySet = (nextValues[name]?.length ?? 0) > 0;
        const wasAi = nextAi.has(name);
        if (currentlySet && !wasAi) continue;
        nextValues[name] = sug.values;
        nextAi.add(name);
        nextMeta[name] = { confidence: sug.confidence, source: sug.source };
        nextSources[name] = "ai_extracted";
        added += 1;
      }
      if (added > 0) onUserEdit?.();
      setAspectValues(nextValues);
      setAiFilled(nextAi);
      setAiMeta(nextMeta);
      setSources(nextSources);
      if (added === 0) {
        toast.info(
          "AI couldn't add anything new — try adding more photos or a tag shot."
        );
      } else {
        toast.success(
          `AI filled ${added} ${added === 1 ? "specific" : "specifics"} from your photos.`
        );
      }
    } catch {
      /* hook surfaces the error toast */
    }
  }

  return (
    <>
      <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>eBay item specifics</CardTitle>
            <CardDescription>
              Pick the leaf category. Specifics are prefilled from the item's
              details where they match — use AI fill for anything left blank.
            </CardDescription>
          </div>
          <div className="flex items-center gap-1">
            {categoryId && aspects.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleAiFill}
                disabled={aiExtract.isPending}
              >
                {aiExtract.isPending ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <Sparkles className="mr-1 h-3 w-3" />
                )}
                AI fill from photos
              </Button>
            )}
            {categoryId && (
              <Button variant="ghost" size="sm" onClick={clearCategory}>
                <X className="mr-1 h-3 w-3" />
                Clear
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Category search / chosen path */}
        {(categoryPath || categoryId) && !changing ? (
          // One block, not a card holding cards: the chosen leaf, then the
          // alternatives AutoLister scored against it, sharing a border.
          <div className="rounded-md border bg-muted/30 text-sm">
            <div className="flex items-center justify-between gap-3 p-3">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Selected category
                </div>
                <div className="font-medium">
                  {displayCategoryPath ?? `Category ${categoryId}`}
                </div>
                {selectedCandidate && selectedCandidate.requiredTotal > 0 && (
                  <div className="text-xs text-muted-foreground">
                    Your item fills{" "}
                    <span className="tabular-nums text-foreground">
                      {selectedCandidate.requiredFilled} of{" "}
                      {selectedCandidate.requiredTotal}
                    </span>{" "}
                    required specifics here
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setChanging(true);
                    setQuery("");
                  }}
                >
                  Change category
                </Button>
              </div>
            </div>

            {/* US-2426: the runner-ups AutoLister already scored (US-2424).
                Switching keeps every specific you have filled — applyCategory
                leaves the aspect state alone and the picker prunes it against
                the new leaf's spec. No AI and no Taxonomy call: these numbers
                came off the draft. */}
            <CategoryCandidateList
              candidates={alternateCandidates}
              onUse={applyCategory}
            />
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="category-search">Search eBay categories</Label>
              {categoryId && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setChanging(false);
                    setQuery("");
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="category-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. men's blazer, women's silk blouse"
                className="pl-8"
              />
              {suggestQuery.isFetching && (
                <Loader2 className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
              )}
            </div>
            {debounced.length >= 2 && suggestQuery.data && (
              <div className="max-h-64 overflow-y-auto rounded-md border">
                {suggestQuery.data.length === 0 ? (
                  <div className="p-3 text-xs text-muted-foreground">
                    No matches. Try a different keyword.
                  </div>
                ) : (
                  suggestQuery.data.map((s) => (
                    <button
                      key={s.categoryId}
                      type="button"
                      onClick={() => pickCategory(s)}
                      className="block w-full border-b px-3 py-2 text-left text-xs hover:bg-muted/50 last:border-b-0"
                    >
                      <div className="font-medium">{s.categoryName}</div>
                      <div className="text-muted-foreground">
                        {s.categoryTreePath}
                      </div>
                    </button>
                  ))
                )}
              </div>
            )}
            {suggestQuery.isError && (
              <p className="text-xs text-destructive">
                {(suggestQuery.error as Error).message}
              </p>
            )}
          </div>
        )}

        {/* Aspects */}
        {categoryId && aspectsQuery.isLoading && (
          <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading specifics for this category…
          </div>
        )}

        {categoryId && aspectsQuery.isError && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
            {(aspectsQuery.error as Error).message}
          </div>
        )}

        {aspects.length > 0 && (
          <div className="space-y-4">
            {/* US-825: pre-publish checklist — surface required-but-unfilled
                aspects at the very top so the seller sees exactly what's missing
                BEFORE publishing, instead of failing later at publish. */}
            {missingRequiredNames.length > 0 && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-destructive">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {missingRequiredNames.length} required{" "}
                  {missingRequiredNames.length === 1 ? "specific" : "specifics"}{" "}
                  still missing
                </div>
                <ul className="mt-1.5 flex flex-wrap gap-1.5">
                  {missingRequiredNames.map((name) => (
                    <li
                      key={name}
                      className="rounded-full border border-destructive/40 px-2 py-0.5 text-[11px] text-destructive"
                    >
                      {name}
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  eBay won't publish until these are filled. Use AI fill or enter
                  them below.
                </p>
              </div>
            )}
            {required.length > 0 && (
              <AspectGroup
                title="Required"
                tone="required"
                itemCategory={itemFields?.item_category ?? null}
                aspects={required}
                values={aspectValues}
                sources={sources}
                aiMeta={aiMeta}
                rewrites={prefillHints}
                isNeedsReview={isNeedsReview}
                onChange={setAspect}
              />
            )}
            {recommended.length > 0 && (
              <AspectGroup
                title="Recommended"
                tone="recommended"
                itemCategory={itemFields?.item_category ?? null}
                aspects={recommended}
                values={aspectValues}
                sources={sources}
                aiMeta={aiMeta}
                rewrites={prefillHints}
                isNeedsReview={isNeedsReview}
                onChange={setAspect}
              />
            )}
            {optional.length > 0 && (
              <AspectGroup
                title="Optional"
                tone="optional"
                itemCategory={itemFields?.item_category ?? null}
                aspects={optional}
                values={aspectValues}
                sources={sources}
                aiMeta={aiMeta}
                rewrites={prefillHints}
                isNeedsReview={isNeedsReview}
                onChange={setAspect}
              />
            )}
          </div>
        )}

        {categoryId && (
          <div className="flex items-center gap-2 border-t pt-4">
            {missingRequired.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-destructive">
                  {missingRequired.length} required{" "}
                  {missingRequired.length === 1 ? "field" : "fields"}
                </span>{" "}
                still empty. Saving the draft keeps your edits; fill these before
                publishing.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                All required fields are filled. Use{" "}
                <span className="font-medium">Save draft</span> above to keep
                these specifics.
              </p>
            )}
          </div>
        )}
      </CardContent>
      </Card>

    </>
  );
}

function AspectGroup({
  title,
  tone,
  aspects,
  values,
  sources,
  aiMeta,
  rewrites,
  isNeedsReview,
  itemCategory,
  onChange,
}: {
  title: string;
  tone: "required" | "recommended" | "optional";
  aspects: EbayAspect[];
  values: Record<string, string[]>;
  sources: AspectSourceMap;
  aiMeta: Record<string, { confidence: number; source: string }>;
  rewrites: Record<string, AspectRewrite>;
  isNeedsReview: (name: string) => boolean;
  itemCategory: string | null;
  onChange: (
    name: string,
    value: string,
    opts: { intent: "toggle" | "set"; multi: boolean },
  ) => void;
}) {
  return (
    <div>
      <div
        className={cn(
          "mb-2 text-[10px] font-semibold uppercase tracking-wide",
          tone === "required" && "text-destructive",
          tone === "recommended" && "text-brand-navy dark:text-foreground",
          tone === "optional" && "text-muted-foreground"
        )}
      >
        {title} ({aspects.length})
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {aspects.map((a) => {
            const columnSynced = syncedItemFieldFor(
              a.localizedAspectName,
              itemCategory,
            );
            const measKey =
              !columnSynced &&
              a.aspectConstraint?.aspectMode !== "SELECTION_ONLY"
                ? measurementKeyForAspect(a.localizedAspectName)
                : null;
            const syncedField =
              columnSynced ??
              (measKey ? `measurements · ${measurementLabel(measKey)}` : null);
            return (
              <AspectField
                key={a.localizedAspectName}
                aspect={a}
                value={values[a.localizedAspectName] ?? []}
                source={sources[a.localizedAspectName]}
                aiMetaItem={aiMeta[a.localizedAspectName]}
                rewrite={rewrites[a.localizedAspectName]}
                needsReview={isNeedsReview(a.localizedAspectName)}
                syncedField={syncedField}
                measurementSynced={!!measKey}
                onChange={(v, intent) =>
                  onChange(a.localizedAspectName, v, {
                    intent,
                    multi:
                      (a.aspectConstraint.itemToAspectCardinality ?? "SINGLE") ===
                      "MULTI",
                  })
                }
              />
            );
          })}
      </div>
    </div>
  );
}

function AspectField({
  aspect,
  value,
  source,
  aiMetaItem,
  rewrite,
  needsReview,
  syncedField,
  measurementSynced,
  onChange,
}: {
  aspect: EbayAspect;
  value: string[];
  source?: StoredAspectProvenance;
  aiMetaItem?: { confidence: number; source: string };
  rewrite?: AspectRewrite;
  needsReview?: boolean;
  /** Item column / Measurements field this aspect is two-way synced with. */
  syncedField?: string | null;
  /** True when syncedField is a Measurements section key (live mirror). */
  measurementSynced?: boolean;
  /** `toggle` = the chip row added/removed one value; `set` = replace the lot. */
  onChange: (v: string, intent: "toggle" | "set") => void;
}) {
  const cardinality = aspect.aspectConstraint.itemToAspectCardinality ?? "SINGLE";
  const mode = aspect.aspectConstraint.aspectMode ?? "FREE_TEXT";
  // While the free-text field is focused, show exactly what the user is typing
  // (`draft`) rather than the canonical stored value. Measurement aspects are
  // two-way-synced with the Measurements section, which re-formats the value
  // with its unit ("31" → "31 in") on every keystroke; without this the reformat
  // would overwrite the input mid-typing and scatter digits after the unit
  // ("3 in", then "3 in 1"). On blur we drop the draft so the formatted value
  // (unit included) takes over. `null` = not editing.
  const [draft, setDraft] = useState<string | null>(null);
  // Build a unique stable id from the aspect name for proper label↔input
  // accessibility wiring (eBay aspect names can include spaces/specials).
  const fieldId = `aspect-${aspect.localizedAspectName.replace(/\W+/g, "-")}`;
  const allowedValues = aspect.aspectValues ?? [];

  return (
    <div
      className={cn(
        "space-y-1",
        // US-828: highlight an aspect the generation reconciler flagged so the
        // seller fixes its value before it silently drops at publish.
        needsReview &&
          "-mx-2 rounded-md border border-amber-500/50 bg-amber-500/5 px-2 py-1.5",
      )}
    >
      <Label
        htmlFor={fieldId}
        className="flex items-center gap-1.5 text-xs"
      >
        {aspect.localizedAspectName}
        {/* US-828: needs-review chip — the value didn't match eBay's allowed set. */}
        {needsReview && (
          <span
            className="rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-medium text-amber-700 dark:text-amber-300"
            title="This value isn't in eBay's allowed list for this aspect — pick a valid one or it won't be sent at publish."
          >
            Review
          </span>
        )}
        {/* Two-way sync hint: edits here update the paired field and vice versa. */}
        {syncedField && (
          <span
            className="rounded bg-muted px-1 py-0.5 text-[9px] font-medium text-muted-foreground"
            title={
              measurementSynced
                ? `Synced live with the Measurements section (${syncedField.replace(/^measurements · /, "")}) — editing either one updates both.`
                : `Synced with the item's ${syncedField.replace(/_/g, " ")} field — editing either one updates both on save.`
            }
          >
            ⇄ {syncedField.replace(/_/g, " ")}
          </span>
        )}
        {/* US-825: provenance badge — AI / Auto (derived) / You (manual). */}
        {source && value.length > 0 && (
          <span
            className={cn(
              "rounded px-1 py-0.5 text-[9px] font-medium",
              source === "ai_extracted" && "bg-primary/10 text-primary",
              source === "inventory_derived" &&
                "bg-brand-navy/10 text-brand-navy dark:text-foreground",
              source === "manual" && "bg-muted text-muted-foreground",
            )}
            title={
              source === "ai_extracted" && aiMetaItem
                ? `${PROVENANCE_BADGE.ai_extracted.title} (${Math.round(
                    aiMetaItem.confidence * 100,
                  )}% confident, ${aiMetaItem.source})`
                : PROVENANCE_BADGE[source].title
            }
          >
            {PROVENANCE_BADGE[source].label}
          </span>
        )}
      </Label>
      {mode === "SELECTION_ONLY" && allowedValues.length > 0 ? (
        cardinality === "MULTI" ? (
          <div className="flex flex-wrap gap-1">
            {allowedValues.map((v) => {
              const selected = value.includes(v.localizedValue);
              return (
                <button
                  key={v.localizedValue}
                  type="button"
                  onClick={() => onChange(v.localizedValue, "toggle")}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-xs transition-colors",
                    selected
                      ? "border-brand-navy bg-brand-navy text-white"
                      : "border-muted-foreground/30 text-muted-foreground hover:bg-muted"
                  )}
                >
                  {v.localizedValue}
                </button>
              );
            })}
          </div>
        ) : (
          <select
            id={fieldId}
            className="w-full rounded-md border bg-background px-2 py-1.5 text-xs"
            value={value[0] ?? ""}
            onChange={(e) => onChange(e.target.value, "set")}
          >
            <option value="">— Choose —</option>
            {allowedValues.map((v) => (
              <option key={v.localizedValue} value={v.localizedValue}>
                {v.localizedValue}
              </option>
            ))}
          </select>
        )
      ) : (
        <Input
          id={fieldId}
          // A MULTI aspect typed as text holds several values; show them all,
          // comma-separated, the way eBay renders them. Showing value[0] alone
          // hid every value past the first and made an edit look discarded.
          value={draft ?? (cardinality === "MULTI" ? value.join(", ") : value[0] ?? "")}
          onChange={(e) => {
            setDraft(e.target.value);
            onChange(e.target.value, "set");
          }}
          onBlur={(e) => {
            // Picking a <datalist> suggestion by mouse fires only a `change`
            // event, never an `input` one — and a controlled input's React
            // onChange listens to `input` alone. So a mouse-picked value never
            // reaches state, and the next render reverts the field to the typed
            // prefix ("leat" instead of the chosen "Leather"). Commit whatever
            // the DOM actually holds on blur before dropping the draft, so a
            // datalist selection sticks. A no-op for plain typing (the value is
            // already committed via onChange).
            const committed = e.currentTarget.value;
            const shown =
              cardinality === "MULTI" ? value.join(", ") : (value[0] ?? "");
            if (committed !== shown) onChange(committed, "set");
            setDraft(null);
          }}
          className="h-8 text-xs"
          list={allowedValues.length > 0 ? `${fieldId}-options` : undefined}
        />
      )}
      {allowedValues.length > 0 && mode !== "SELECTION_ONLY" && (
        <datalist id={`${fieldId}-options`}>
          {allowedValues.map((v) => (
            <option key={v.localizedValue} value={v.localizedValue} />
          ))}
        </datalist>
      )}
      {rewrite && value[0] === rewrite.to && (
        <p className="text-[10px] text-muted-foreground">
          <span className="font-medium">“{rewrite.from}”</span> matched eBay's
          value — will be sent as{" "}
          <span className="font-medium">“{rewrite.to}”</span>.
        </p>
      )}
    </div>
  );
}
