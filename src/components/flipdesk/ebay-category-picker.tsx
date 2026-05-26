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
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  useAiExtractAspects,
  useEbayCategoryAspects,
  useEbayCategorySuggest,
  useSaveEbayCategoryMapping,
  type EbayAspect,
  type EbayCategorySuggestion,
} from "@/hooks/use-ebay";
import { cn } from "@/lib/utils";

interface Props {
  itemId: string;
  initialCategoryId: string | null;
  initialAspects: Record<string, string[]> | null;
  // When set, the picker uses this as the default query on first mount —
  // typically the item's title so the user lands on a relevant suggestion.
  seedQuery?: string;
  // Notifies the parent every time the user picks (or clears) a category,
  // so siblings like the comps panel can react before the save is committed.
  onCategoryChange?: (categoryId: string | null) => void;
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
  seedQuery,
  onCategoryChange,
}: Props) {
  const [query, setQuery] = useState(seedQuery ?? "");
  const debounced = useDebounced(query.trim(), 250);

  const [categoryId, setCategoryId] = useState<string | null>(
    initialCategoryId
  );
  const [categoryPath, setCategoryPath] = useState<string | null>(null);

  // aspectValues: { [aspectName]: string[] }. We always store arrays so MULTI-
  // cardinality aspects fit the same shape. SINGLE aspects use a length-1 array.
  const [aspectValues, setAspectValues] = useState<Record<string, string[]>>(
    initialAspects ?? {}
  );

  // Aspect names the AI most recently filled — drives the "AI" badge.
  const [aiFilled, setAiFilled] = useState<Set<string>>(new Set());
  // Per-aspect confidence for the "AI" badge tooltip / styling.
  const [aiMeta, setAiMeta] = useState<
    Record<string, { confidence: number; source: string }>
  >({});

  const suggestQuery = useEbayCategorySuggest(debounced);
  const aspectsQuery = useEbayCategoryAspects(categoryId);
  const save = useSaveEbayCategoryMapping();
  const aiExtract = useAiExtractAspects();

  const initialAspectsRef = useRef(initialAspects);
  // When the user picks a different category, drop any aspect values that no
  // longer apply. Keep the rest so a re-pick doesn't wipe the user's work.
  useEffect(() => {
    if (!aspectsQuery.data) return;
    const valid = new Set(
      (aspectsQuery.data.aspects.aspects ?? []).map(
        (a) => a.localizedAspectName
      )
    );
    setAspectValues((prev) => {
      const next: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(prev)) {
        if (valid.has(k)) next[k] = v;
      }
      // Re-seed from initial on first load if we haven't applied them yet.
      if (initialAspectsRef.current && Object.keys(prev).length === 0) {
        for (const [k, v] of Object.entries(initialAspectsRef.current)) {
          if (valid.has(k)) next[k] = v;
        }
      }
      return next;
    });
  }, [aspectsQuery.data]);

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

  const missingRequired = required.filter(
    (a) => !aspectValues[a.localizedAspectName]?.length
  );

  function pickCategory(s: EbayCategorySuggestion) {
    setCategoryId(s.categoryId);
    setCategoryPath(s.categoryTreePath);
    setQuery("");
    onCategoryChange?.(s.categoryId);
  }

  function clearCategory() {
    setCategoryId(null);
    setCategoryPath(null);
    setAspectValues({});
    setAiFilled(new Set());
    setAiMeta({});
    onCategoryChange?.(null);
  }

  function setAspect(name: string, value: string, cardinality: string) {
    setAspectValues((prev) => {
      if (cardinality === "MULTI") {
        const existing = prev[name] ?? [];
        return existing.includes(value)
          ? { ...prev, [name]: existing.filter((v) => v !== value) }
          : { ...prev, [name]: [...existing, value] };
      }
      return { ...prev, [name]: value ? [value] : [] };
    });
    // A manual edit clears the AI marker for that aspect.
    setAiFilled((prev) => {
      if (!prev.has(name)) return prev;
      const next = new Set(prev);
      next.delete(name);
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
      for (const [name, sug] of Object.entries(result.suggestions)) {
        const currentlySet = (nextValues[name]?.length ?? 0) > 0;
        const wasAi = nextAi.has(name);
        if (currentlySet && !wasAi) continue;
        nextValues[name] = sug.values;
        nextAi.add(name);
        nextMeta[name] = { confidence: sug.confidence, source: sug.source };
        added += 1;
      }
      setAspectValues(nextValues);
      setAiFilled(nextAi);
      setAiMeta(nextMeta);
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

  async function handleSave() {
    if (!categoryId) {
      toast.error("Pick an eBay category first.");
      return;
    }
    if (missingRequired.length > 0) {
      toast.error(
        `Missing required ${
          missingRequired.length === 1 ? "field" : "fields"
        }: ${missingRequired
          .slice(0, 3)
          .map((a) => a.localizedAspectName)
          .join(", ")}${missingRequired.length > 3 ? "…" : ""}`
      );
      return;
    }
    await save.mutateAsync({
      itemId,
      categoryId,
      aspects: aspectValues,
    });
    toast.success("eBay category + specifics saved.");
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              eBay item specifics
              <Badge variant="secondary" className="font-normal">
                Week 1
              </Badge>
            </CardTitle>
            <CardDescription>
              Pick the leaf category. eBay tells us which specifics buyers
              filter on — we render them below. Week 2 will pre-fill these
              from the photos.
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
        {categoryPath || categoryId ? (
          <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 p-3 text-sm">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Selected category
              </div>
              <div className="font-medium">
                {categoryPath ?? `Category ${categoryId}`}
              </div>
            </div>
            <Check className="h-4 w-4 text-emerald-600" />
          </div>
        ) : (
          <div className="space-y-2">
            <Label>Search eBay categories</Label>
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
            {required.length > 0 && (
              <AspectGroup
                title="Required"
                tone="required"
                aspects={required}
                values={aspectValues}
                aiFilled={aiFilled}
                aiMeta={aiMeta}
                onChange={setAspect}
              />
            )}
            {recommended.length > 0 && (
              <AspectGroup
                title="Recommended"
                tone="recommended"
                aspects={recommended}
                values={aspectValues}
                aiFilled={aiFilled}
                aiMeta={aiMeta}
                onChange={setAspect}
              />
            )}
            {optional.length > 0 && (
              <AspectGroup
                title="Optional"
                tone="optional"
                aspects={optional}
                values={aspectValues}
                aiFilled={aiFilled}
                aiMeta={aiMeta}
                onChange={setAspect}
              />
            )}
          </div>
        )}

        {categoryId && (
          <div className="flex items-center justify-between border-t pt-4">
            <p className="text-xs text-muted-foreground">
              {missingRequired.length > 0
                ? `${missingRequired.length} required ${
                    missingRequired.length === 1 ? "field" : "fields"
                  } still empty.`
                : "All required fields are filled."}
            </p>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={save.isPending || missingRequired.length > 0}
            >
              {save.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Save eBay specifics
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AspectGroup({
  title,
  tone,
  aspects,
  values,
  aiFilled,
  aiMeta,
  onChange,
}: {
  title: string;
  tone: "required" | "recommended" | "optional";
  aspects: EbayAspect[];
  values: Record<string, string[]>;
  aiFilled: Set<string>;
  aiMeta: Record<string, { confidence: number; source: string }>;
  onChange: (name: string, value: string, cardinality: string) => void;
}) {
  return (
    <div>
      <div
        className={cn(
          "mb-2 text-[10px] font-semibold uppercase tracking-wide",
          tone === "required" && "text-destructive",
          tone === "recommended" && "text-brand-navy",
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
            aiFilled={aiFilled.has(a.localizedAspectName)}
            aiMetaItem={aiMeta[a.localizedAspectName]}
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
  aiFilled,
  aiMetaItem,
  onChange,
}: {
  aspect: EbayAspect;
  value: string[];
  aiFilled: boolean;
  aiMetaItem?: { confidence: number; source: string };
  onChange: (v: string) => void;
}) {
  const cardinality = aspect.aspectConstraint.itemToAspectCardinality ?? "SINGLE";
  const mode = aspect.aspectConstraint.aspectMode ?? "FREE_TEXT";
  // Build a unique stable id from the aspect name for proper label↔input
  // accessibility wiring (eBay aspect names can include spaces/specials).
  const fieldId = `aspect-${aspect.localizedAspectName.replace(/\W+/g, "-")}`;
  const allowedValues = aspect.aspectValues ?? [];

  return (
    <div className="space-y-1">
      <Label
        htmlFor={fieldId}
        className="flex items-center gap-1.5 text-xs"
      >
        {aspect.localizedAspectName}
        {aiFilled && (
          <span
            className="rounded bg-primary/10 px-1 py-0.5 text-[9px] font-medium text-primary"
            title={
              aiMetaItem
                ? `AI-filled (${Math.round(aiMetaItem.confidence * 100)}% confident, ${aiMetaItem.source})`
                : "AI-filled"
            }
          >
            AI
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
    </div>
  );
}
