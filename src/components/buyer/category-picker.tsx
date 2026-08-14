import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { BUYER_CATEGORY_OPTIONS } from "@/lib/buyer-taxonomy";

/**
 * Pick the garment categories a buyer is hunting (US-2552).
 *
 * There is one of these rather than four, because four surfaces write the same
 * criteria and were doing it four different ways: onboarding had a hardcoded 13
 * chips, settings a hardcoded 19, and the demand board and saved-search alerts
 * took free text. Matching is exact equality against the garment taxonomy, so
 * the free-text ones let a buyer save "jackets" and wait forever.
 */
export function CategoryPicker({
  label = "Categories",
  hint,
  values,
  onChange,
}: {
  label?: string;
  hint?: string;
  values: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <div className="flex flex-wrap gap-2">
        {BUYER_CATEGORY_OPTIONS.map((c) => {
          const selected = values.includes(c);
          return (
            <button
              key={c}
              type="button"
              aria-pressed={selected}
              onClick={() =>
                onChange(
                  selected ? values.filter((x) => x !== c) : [...values, c],
                )
              }
              className={cn(
                "rounded-full border px-3 py-1.5 text-sm capitalize transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border hover:border-primary/40",
              )}
            >
              {c}
            </button>
          );
        })}
      </div>
    </div>
  );
}
