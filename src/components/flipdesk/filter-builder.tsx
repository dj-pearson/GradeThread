import { Filter, Plus, X } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  FIELD_LABELS,
  OP_LABELS,
  NUMERIC_FIELDS,
  NUMERIC_OPS,
  TEXT_OPS,
  type FilterField,
  type FilterOp,
  type FilterQuery,
  type FilterRule,
} from "@/lib/item-filter";

function newRule(): FilterRule {
  return {
    id: Math.random().toString(36).slice(2),
    field: "brand",
    op: "eq",
    value: "",
  };
}

const ALL_FIELDS: FilterField[] = [
  "brand",
  "category",
  "size",
  "source",
  "cost",
  "target_price",
  "status",
  "grade",
  "days_in_status",
];

export function FilterBuilder({
  query,
  onChange,
}: {
  query: FilterQuery;
  onChange: (q: FilterQuery) => void;
}) {
  const ruleCount = query.rules.length;

  function patchRule(id: string, patch: Partial<FilterRule>) {
    onChange({
      ...query,
      rules: query.rules.map((r) => {
        if (r.id !== id) return r;
        const next = { ...r, ...patch };
        // If the field type changed, snap the operator to a valid one.
        if (patch.field) {
          const ops = NUMERIC_FIELDS.has(patch.field) ? NUMERIC_OPS : TEXT_OPS;
          if (!ops.includes(next.op)) next.op = ops[0]!;
        }
        return next;
      }),
    });
  }

  function removeRule(id: string) {
    onChange({ ...query, rules: query.rules.filter((r) => r.id !== id) });
  }

  function addRule() {
    onChange({ ...query, rules: [...query.rules, newRule()] });
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant={ruleCount > 0 ? "default" : "outline"} size="sm">
          <Filter className="mr-2 h-4 w-4" />
          Filter
          {ruleCount > 0 && (
            <span className="ml-1.5 rounded bg-background/30 px-1.5 text-[10px]">
              {ruleCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[420px] p-3" align="start">
        <div className="mb-2 flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Match</span>
          <div className="flex overflow-hidden rounded-md border">
            {(["and", "or"] as const).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => onChange({ ...query, combinator: c })}
                className={cn(
                  "px-2 py-0.5",
                  query.combinator === c
                    ? "bg-brand-navy text-white"
                    : "hover:bg-muted",
                )}
              >
                {c === "and" ? "all" : "any"}
              </button>
            ))}
          </div>
          <span className="text-muted-foreground">of these rules</span>
        </div>

        <div className="space-y-2">
          {query.rules.length === 0 && (
            <div className="rounded-md border border-dashed py-4 text-center text-xs text-muted-foreground">
              No rules. Add one below.
            </div>
          )}
          {query.rules.map((rule) => {
            const ops = NUMERIC_FIELDS.has(rule.field)
              ? NUMERIC_OPS
              : TEXT_OPS;
            const needsValue = rule.op !== "isnull" && rule.op !== "notnull";
            return (
              <div key={rule.id} className="flex items-center gap-1.5">
                <Select
                  value={rule.field}
                  onValueChange={(v) =>
                    patchRule(rule.id, { field: v as FilterField })
                  }
                >
                  <SelectTrigger className="h-8 w-32 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ALL_FIELDS.map((f) => (
                      <SelectItem key={f} value={f}>
                        {FIELD_LABELS[f]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={rule.op}
                  onValueChange={(v) =>
                    patchRule(rule.id, { op: v as FilterOp })
                  }
                >
                  <SelectTrigger className="h-8 w-24 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ops.map((o) => (
                      <SelectItem key={o} value={o}>
                        {OP_LABELS[o]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {needsValue ? (
                  <Input
                    value={rule.value}
                    onChange={(e) =>
                      patchRule(rule.id, { value: e.target.value })
                    }
                    placeholder={
                      rule.op === "in" || rule.op === "nin"
                        ? "a, b, c"
                        : "value"
                    }
                    className="h-8 flex-1 text-xs"
                  />
                ) : (
                  <div className="flex-1" />
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 flex-shrink-0"
                  onClick={() => removeRule(rule.id)}
                  aria-label="Remove rule"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })}
        </div>

        <div className="mt-2 flex items-center justify-between">
          <Button variant="outline" size="sm" onClick={addRule}>
            <Plus className="mr-1 h-3 w-3" />
            Add rule
          </Button>
          {query.rules.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChange({ combinator: query.combinator, rules: [] })}
            >
              Clear all
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
