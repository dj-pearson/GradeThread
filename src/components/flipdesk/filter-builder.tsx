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
  FILTER_FIELDS,
  DATE_FIELDS,
  ENUM_FIELDS,
  ENUM_FIELD_OPTIONS,
  opsForField,
  opLabel,
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
        // If the field type changed, snap the operator to a valid one and
        // clear a value that no longer makes sense for the new field type.
        if (patch.field) {
          const ops = opsForField(patch.field);
          if (!ops.includes(next.op)) next.op = ops[0]!;
          // Switching to/from an enum field invalidates a free-text value.
          if (ENUM_FIELDS.has(patch.field) || ENUM_FIELDS.has(r.field)) {
            next.value = "";
          }
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
      {/* US-2028: w-[460px] alone overflowed any viewport under 460px — an
          iPhone SE is 375px and an iPhone 14 is 390px, and FlipDesk filtering is
          a seller workflow, not an admin screen. Clamp to the viewport on small
          screens and keep the roomy width from sm up. */}
      <PopoverContent
        className="w-[calc(100vw-2rem)] p-3 sm:w-[460px]"
        align="start"
      >
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
          {query.rules.map((rule, ruleIndex) => {
            const ops = opsForField(rule.field);
            const needsValue = rule.op !== "isnull" && rule.op !== "notnull";
            const isEnum = ENUM_FIELDS.has(rule.field);
            const isDate = DATE_FIELDS.has(rule.field);
            const enumOptions = ENUM_FIELD_OPTIONS[rule.field];
            return (
              <div key={rule.id} className="flex items-center gap-1.5">
                <Select
                  value={rule.field}
                  onValueChange={(v) =>
                    patchRule(rule.id, { field: v as FilterField })
                  }
                >
                  <SelectTrigger className="h-8 w-32 text-xs" aria-label={`Field for rule ${ruleIndex + 1}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FILTER_FIELDS.map((f) => (
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
                  <SelectTrigger className="h-8 w-28 text-xs" aria-label={`Operator for rule ${ruleIndex + 1}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ops.map((o) => (
                      <SelectItem key={o} value={o}>
                        {opLabel(rule.field, o)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!needsValue ? (
                  <div className="flex-1" />
                ) : isEnum && enumOptions ? (
                  <Select
                    value={rule.value}
                    onValueChange={(v) => patchRule(rule.id, { value: v })}
                  >
                    <SelectTrigger className="h-8 flex-1 text-xs" aria-label={`Value for rule ${ruleIndex + 1}`}>
                      <SelectValue placeholder="Select…" />
                    </SelectTrigger>
                    <SelectContent>
                      {enumOptions.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : isDate ? (
                  <Input
                    type="date"
                    aria-label={`Value for rule ${ruleIndex + 1}`}
                    value={rule.value}
                    onChange={(e) =>
                      patchRule(rule.id, { value: e.target.value })
                    }
                    className="h-8 flex-1 text-xs"
                  />
                ) : (
                  <Input
                    aria-label={`Value for rule ${ruleIndex + 1}`}
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
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 flex-shrink-0"
                  onClick={() => removeRule(rule.id)}
                  aria-label={`Remove rule ${ruleIndex + 1}`}
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
