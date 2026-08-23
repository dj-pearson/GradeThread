import { useEffect, useState } from "react";
import {
  FileText,
  Loader2,
  Plus,
  Search,
  Tags,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useEbayCategorySuggest } from "@/hooks/use-ebay";
import { estimateListingProfit } from "@/lib/listing-profit";
import { textChanged } from "@/lib/listing-ai-diff";
import { AiDiffChip } from "@/components/flipdesk/ai-diff-chip";
import { cn } from "@/lib/utils";

// US-2520: the bulk-edit grid's cell renderers, lifted out of
// autolister-bulk-edit.tsx. Every one of them is prop-only — no page state, no
// queries — which is exactly why they did not need to live inside a
// 2,400-line file.

export function DescriptionCell({
  value,
  aiDescription,
  onChange,
}: {
  value: string;
  aiDescription: string | null;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const snippet = value.replace(/\s+/g, " ").trim();
  return (
    <div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex h-8 w-full items-center gap-1.5 truncate rounded-md border border-input bg-transparent px-2 text-left text-xs",
              !snippet && "text-muted-foreground",
            )}
            title={snippet || "Edit description"}
          >
            <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="truncate">{snippet || "Add description…"}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[28rem] p-2">
          <Textarea aria-label="Description"
            autoFocus
            value={value}
            onChange={(e) => onChange(e.target.value)}
            rows={12}
            placeholder="Listing description…"
            className="text-sm"
          />
          <div className="mt-1 flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">
              {value.length} chars
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setOpen(false)}
            >
              Done
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {aiDescription != null && (
        <AiDiffChip
          changed={textChanged(aiDescription, value)}
          aiDisplay={aiDescription}
          onRevert={() => onChange(aiDescription)}
          className="mt-1"
        />
      )}
    </div>
  );
}

// US-556: edit the arbitrary item specifics (every aspect except the dedicated
// Department/Brand/Size/Color columns) inline. Each entry is a name + a
// comma-separated value list, matching how eBay aspects accept multiple values.
// Required-but-missing aspects for the row's category are surfaced as one-click
// add chips so the same publish blockers the grid already flags can be cleared
// here. Writes back into the row's `specifics`, which the shared save path
// merges into item_specifics_override losslessly.
export function SpecificsCell({
  specifics,
  requiredNames,
  onChange,
}: {
  specifics: Record<string, string[]>;
  requiredNames: string[];
  onChange: (next: Record<string, string[]>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [newKey, setNewKey] = useState("");
  const entries = Object.entries(specifics);
  const filledCount = entries.filter(([, v]) =>
    (v ?? []).some((x) => x.trim()),
  ).length;
  const missingRequired = requiredNames.filter(
    (n) => !(specifics[n] ?? []).some((x) => x.trim()),
  );

  function setValues(key: string, raw: string) {
    const values = raw.split(",").map((v) => v.trimStart());
    onChange({ ...specifics, [key]: values });
  }
  function removeKey(key: string) {
    const next = { ...specifics };
    delete next[key];
    onChange(next);
  }
  function addKey(name: string) {
    const k = name.trim();
    if (!k || specifics[k]) return;
    onChange({ ...specifics, [k]: [] });
    setNewKey("");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-8 w-full items-center gap-1.5 truncate rounded-md border bg-transparent px-2 text-left text-xs",
            missingRequired.length > 0
              ? "border-amber-400 text-amber-700 dark:text-amber-300"
              : "border-input",
            filledCount === 0 && missingRequired.length === 0 &&
              "text-muted-foreground",
          )}
          title={
            missingRequired.length > 0
              ? `Missing required: ${missingRequired.join(", ")}`
              : "Edit item specifics"
          }
        >
          <Tags className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="truncate">
            {filledCount > 0
              ? `${filledCount} specific${filledCount === 1 ? "" : "s"}`
              : "Add specifics…"}
            {missingRequired.length > 0 ? ` · ${missingRequired.length} req` : ""}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-2">
        <div className="max-h-72 space-y-1.5 overflow-y-auto">
          {entries.length === 0 && (
            <p className="px-1 py-2 text-xs text-muted-foreground">
              No extra item specifics yet. Add one below, or use a required-aspect
              chip.
            </p>
          )}
          {entries.map(([name, values]) => (
            <div key={name} className="flex items-center gap-1.5">
              <span
                className="w-28 shrink-0 truncate text-xs font-medium"
                title={name}
              >
                {name}
              </span>
              <Input aria-label={`${name} values`}
                value={(values ?? []).join(", ")}
                onChange={(e) => setValues(name, e.target.value)}
                placeholder="value(s), comma-separated"
                className="h-7 text-xs"
              />
              <button
                type="button"
                onClick={() => removeKey(name)}
                aria-label={`Remove ${name}`}
                className="shrink-0 text-muted-foreground hover:text-destructive"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
        {missingRequired.length > 0 && (
          <div className="mt-2 border-t pt-2">
            <p className="mb-1 text-[10px] uppercase text-muted-foreground">
              Required for this category
            </p>
            <div className="flex flex-wrap gap-1">
              {missingRequired.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => addKey(n)}
                  className="inline-flex items-center gap-1 rounded-full border border-amber-300/70 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300"
                >
                  <Plus className="h-2.5 w-2.5" />
                  {n}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="mt-2 flex items-center gap-1.5 border-t pt-2">
          <Input aria-label="New item specific name"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addKey(newKey);
              }
            }}
            placeholder="New aspect name"
            className="h-7 text-xs"
          />
          <Button
            size="sm"
            variant="secondary"
            className="h-7 shrink-0 text-xs"
            disabled={!newKey.trim() || !!specifics[newKey.trim()]}
            onClick={() => addKey(newKey)}
          >
            <Plus className="mr-1 h-3 w-3" />
            Add
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// US-553: forward net profit + margin for one row, recomputed live from the
// current price string and the item's cost basis. Mirrors the composer's
// thresholds (red = loss, amber = thin margin, green = healthy). A missing cost
// basis still shows fees-only net, with a hint so the number isn't trusted blind.
export function PnlCell({
  price,
  cost,
}: {
  price: string;
  cost: number | null;
}) {
  const parsed = Number.parseFloat(price);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const { net, marginPct } = estimateListingProfit({
    price: parsed,
    costBasis: cost,
  });
  return (
    <div className="text-xs tabular-nums">
      <div
        className={cn(
          "font-semibold",
          net < 0
            ? "text-destructive"
            : marginPct < 20
              ? "text-amber-600 dark:text-amber-400"
              : "text-emerald-600 dark:text-emerald-400",
        )}
      >
        ${net.toFixed(2)}
      </div>
      <div className="text-muted-foreground">{marginPct.toFixed(0)}% margin</div>
      {cost == null && (
        <div
          className="text-[10px] text-amber-600 dark:text-amber-400"
          title="No cost basis on this item — margin excludes acquisition cost."
        >
          no cost
        </div>
      )}
    </div>
  );
}

// US-555: compact S/P/R badges showing which per-listing business policies are
// overridden. A lit letter means an override is set (title shows the policy
// name); a dim letter means it falls back to the account default at publish.
export function PolicyBadges({
  shippingId,
  paymentId,
  returnId,
  labels,
}: {
  shippingId: string;
  paymentId: string;
  returnId: string;
  labels: Record<string, string>;
}) {
  const entries: Array<{ key: string; letter: string; id: string }> = [
    { key: "ship", letter: "S", id: shippingId },
    { key: "pay", letter: "P", id: paymentId },
    { key: "ret", letter: "R", id: returnId },
  ];
  return (
    <div className="flex gap-1">
      {entries.map((e) => (
        <span
          key={e.key}
          title={e.id ? labels[e.id] ?? e.id : "Uses your account default policy"}
          className={cn(
            "inline-flex h-5 w-5 items-center justify-center rounded text-[10px] font-semibold",
            e.id ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground/50",
          )}
        >
          {e.letter}
        </span>
      ))}
    </div>
  );
}

// Small debounce so each keystroke across many rows doesn't hammer the Taxonomy
// suggest endpoint. The query only fires once the value settles for `ms`.
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

// Taxonomy-backed category search in a popover. Used both per-row and in the
// bulk-apply toolbar. Renders the picked leaf's path (or its id when the path
// isn't known yet) on the trigger; searching hits eBay's live category tree via
// useEbayCategorySuggest, so every eBay category is reachable with nothing
// hardcoded. The popover content is portaled, so the table's horizontal scroll
// container never clips the results.
export function CategorySearchControl({
  id,
  categoryId,
  categoryPath,
  onPick,
  onClear,
  triggerClassName,
  align = "center",
}: {
  id?: string;
  categoryId: string;
  categoryPath: string;
  onPick: (id: string, path: string) => void;
  onClear?: () => void;
  triggerClassName?: string;
  align?: "start" | "center" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query.trim(), 250);
  const suggest = useEbayCategorySuggest(debounced);
  const results = suggest.data ?? [];

  const label = categoryPath || (categoryId ? `Category #${categoryId}` : "");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          className={cn(
            "flex h-8 items-center gap-1.5 truncate rounded-md border border-input bg-transparent px-2 text-left text-xs",
            !label && "text-muted-foreground",
            triggerClassName,
          )}
          title={label || "Search eBay categories"}
        >
          <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{label || "Search category…"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-80 p-0">
        <div className="border-b p-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="Search categories"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. women's blouse, men's blazer"
              className="h-8 pl-7 text-xs"
            />
            {suggest.isFetching && (
              <Loader2 className="absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
            )}
          </div>
        </div>
        <div className="max-h-64 overflow-y-auto">
          {debounced.length < 2 ? (
            <div className="p-3 text-xs text-muted-foreground">
              Type at least 2 characters to search eBay categories.
            </div>
          ) : results.length === 0 && !suggest.isFetching ? (
            <div className="p-3 text-xs text-muted-foreground">
              No matches. Try a different keyword.
            </div>
          ) : (
            results.map((s) => (
              <button
                key={s.categoryId}
                type="button"
                onClick={() => {
                  onPick(s.categoryId, s.categoryTreePath);
                  setOpen(false);
                  setQuery("");
                }}
                className="block w-full border-b px-3 py-2 text-left text-xs last:border-b-0 hover:bg-muted/50"
              >
                <div className="font-medium">{s.categoryName}</div>
                <div className="text-muted-foreground">{s.categoryTreePath}</div>
              </button>
            ))
          )}
        </div>
        {categoryId && onClear && (
          <div className="border-t p-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-full text-xs"
              onClick={() => {
                onClear();
                setOpen(false);
                setQuery("");
              }}
            >
              Clear category
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
