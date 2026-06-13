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
import {
  remapAspectsForCategory,
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

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
  // Notifies the parent every time the user picks (or clears) a category,
  // so siblings like the comps panel can react before the save is committed.
  onCategoryChange?: (categoryId: string | null) => void;
  // US-557: surfaces the live aspect map to the parent on every edit. The
  // composer owns persistence now — there's ONE Save (the draft save) that
  // writes these aspects to both the listing override and the inventory mirror,
  // so picker edits can't vanish by skipping a separate "Save specifics" click.
  onAspectsChange?: (aspects: Record<string, string[]>) => void;
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
  onCategoryChange,
  onAspectsChange,
  onSourcesChange,
  onMissingRequiredChange,
  needsReviewAspects,
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
  const categoryPathRef = useRef(categoryPath);
  useEffect(() => {
    categoryPathRef.current = categoryPath;
  }, [categoryPath]);
  // The category whose spec is currently reflected in `aspectValues`. Starts at
  // the item's saved category so the first spec load is treated as initial
  // (no discard prompt), not as a user-initiated change.
  const appliedCategoryRef = useRef<string | null>(initialCategoryId);
  const appliedCategoryPathRef = useRef<string | null>(null);
  // When a category change would discard previously-entered specifics, we hold
  // the change and ask first instead of dropping silently.
  const [pendingDiscard, setPendingDiscard] = useState<{
    toCategoryId: string;
    toCategoryPath: string | null;
    fromCategoryId: string | null;
    fromCategoryPath: string | null;
    dropped: Record<string, string[]>;
  } | null>(null);

  // Commit a remap result: keep still-valid values, add the derived gap-fills,
  // refresh the "sent as" hints, and clear AI/hint markers for dropped aspects.
  const commitRemap = (aspectList: EbayAspect[], result: AspectRemapResult) => {
    const nextValues = { ...result.kept, ...result.derived };
    setAspectValues(nextValues);
    // US-825: kept values keep their prior provenance; the gap-fills the remap
    // just derived are inventory_derived. Dropped aspects fall away with prune.
    setSources((prev) => {
      const next: AspectSourceMap = {};
      for (const k of Object.keys(result.kept)) {
        if (prev[k]) next[k] = prev[k];
      }
      for (const k of Object.keys(result.derived)) {
        next[k] = "inventory_derived";
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
    if (Object.keys(result.dropped).length > 0) {
      const droppedNames = Object.keys(result.dropped);
      setAiFilled((prev) => {
        const next = new Set(prev);
        for (const n of droppedNames) next.delete(n);
        return next;
      });
    }
  };

  // When the user picks a different category, refetch its spec and refill
  // deterministically from data we already have (still-valid values + the
  // item's columns/US-821 attributes mapped through the registry) — zero AI.
  // A genuine change that would discard values is gated behind a confirm.
  useEffect(() => {
    if (!aspectsQuery.data) return;
    const aspectList = aspectsQuery.data.aspects.aspects ?? [];
    const result = remapAspectsForCategory(
      aspectValuesRef.current,
      aspectList,
      itemFields ?? null,
    );
    // Same id we last applied ⇒ first load or a re-fetch (itemFields change),
    // not a user category switch — apply without prompting.
    const isInitial = appliedCategoryRef.current === categoryId;
    if (!isInitial && Object.keys(result.dropped).length > 0) {
      setPendingDiscard({
        toCategoryId: categoryId!,
        toCategoryPath: categoryPathRef.current,
        fromCategoryId: appliedCategoryRef.current,
        fromCategoryPath: appliedCategoryPathRef.current,
        dropped: result.dropped,
      });
      return;
    }
    commitRemap(aspectList, result);
    appliedCategoryRef.current = categoryId;
    appliedCategoryPathRef.current = categoryPathRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aspectsQuery.data, itemFields]);

  function confirmDiscard() {
    if (!pendingDiscard || !aspectsQuery.data) return;
    const aspectList = aspectsQuery.data.aspects.aspects ?? [];
    const result = remapAspectsForCategory(
      aspectValuesRef.current,
      aspectList,
      itemFields ?? null,
    );
    commitRemap(aspectList, result);
    appliedCategoryRef.current = pendingDiscard.toCategoryId;
    appliedCategoryPathRef.current = pendingDiscard.toCategoryPath;
    setPendingDiscard(null);
  }

  // Revert to the previous category (cached spec re-resolves instantly and the
  // effect re-applies it as "initial", so no values are lost).
  function cancelDiscard() {
    if (!pendingDiscard) return;
    const backId = pendingDiscard.fromCategoryId;
    const backPath = pendingDiscard.fromCategoryPath;
    setPendingDiscard(null);
    setCategoryId(backId);
    setCategoryPath(backPath);
    onCategoryChange?.(backId);
  }

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
  const missingKey = missingRequiredNames.join("\n");
  useEffect(() => {
    onMissingRequiredChange?.(missingRequiredNames);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missingKey, onMissingRequiredChange]);

  function pickCategory(s: EbayCategorySuggestion) {
    setCategoryId(s.categoryId);
    setCategoryPath(s.categoryTreePath);
    setQuery("");
    setChanging(false);
    onCategoryChange?.(s.categoryId);
  }

  function clearCategory() {
    setCategoryId(null);
    setCategoryPath(null);
    setAspectValues({});
    setSources({});
    setAiFilled(new Set());
    setAiMeta({});
    setPrefillHints({});
    appliedCategoryRef.current = null;
    appliedCategoryPathRef.current = null;
    onCategoryChange?.(null);
  }

  function setAspect(name: string, value: string, cardinality: string) {
    // Compute the resulting value array so provenance can track whether the
    // aspect is now filled (manual) or cleared (drop the source entry).
    const existing = aspectValues[name] ?? [];
    const nextArr =
      cardinality === "MULTI"
        ? existing.includes(value)
          ? existing.filter((v) => v !== value)
          : [...existing, value]
        : value
          ? [value]
          : [];
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

  const droppedEntries = pendingDiscard
    ? Object.entries(pendingDiscard.dropped)
    : [];

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
          <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 p-3 text-sm">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Selected category
              </div>
              <div className="font-medium">
                {categoryPath ?? `Category ${categoryId}`}
              </div>
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
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Search eBay categories</Label>
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

      {/* US-824: confirm before discarding specifics that don't carry over to
          the new category — never drop the user's work silently. */}
      <AlertDialog
        open={!!pendingDiscard}
        onOpenChange={(next) => {
          if (!next) cancelDiscard();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {droppedEntries.length} item{" "}
              {droppedEntries.length === 1 ? "specific" : "specifics"} won't
              carry over
            </AlertDialogTitle>
            <AlertDialogDescription>
              These values don't apply to the new category and will be removed.
              Still-valid values (like Brand, Color, Material) are kept, and gaps
              are refilled from this item — no AI is used.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border bg-muted/30 p-3 text-xs">
            {droppedEntries.map(([name, values]) => (
              <li key={name} className="flex justify-between gap-3">
                <span className="font-medium">{name}</span>
                <span className="truncate text-muted-foreground">
                  {values.join(", ")}
                </span>
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelDiscard}>
              Keep current category
            </AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirmDiscard}>
              Change &amp; remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  onChange: (name: string, value: string, cardinality: string) => void;
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
        {aspects.map((a) => (
          <AspectField
            key={a.localizedAspectName}
            aspect={a}
            value={values[a.localizedAspectName] ?? []}
            source={sources[a.localizedAspectName]}
            aiMetaItem={aiMeta[a.localizedAspectName]}
            rewrite={rewrites[a.localizedAspectName]}
            needsReview={isNeedsReview(a.localizedAspectName)}
            onChange={(v) =>
              onChange(
                a.localizedAspectName,
                v,
                a.aspectConstraint.itemToAspectCardinality ?? "SINGLE"
              )
            }
          />
        ))}
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
  onChange,
}: {
  aspect: EbayAspect;
  value: string[];
  source?: StoredAspectProvenance;
  aiMetaItem?: { confidence: number; source: string };
  rewrite?: AspectRewrite;
  needsReview?: boolean;
  onChange: (v: string) => void;
}) {
  const cardinality = aspect.aspectConstraint.itemToAspectCardinality ?? "SINGLE";
  const mode = aspect.aspectConstraint.aspectMode ?? "FREE_TEXT";
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
                  onClick={() => onChange(v.localizedValue)}
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
            onChange={(e) => onChange(e.target.value)}
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
          value={value[0] ?? ""}
          onChange={(e) => onChange(e.target.value)}
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
