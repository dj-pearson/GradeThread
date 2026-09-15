import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  Hash,
  Plus,
  TriangleAlert,
  Trash2,
} from "lucide-react";
import { Link } from "react-router";
import { toast } from "sonner";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { cn } from "@/lib/utils";
import {
  blankSegment,
  countingSlots,
  DEFAULT_ALPHABET,
  fitCounters,
  SKU_PRESETS,
  type SkuPreset,
  type SkuSegment,
} from "@/lib/sku-presets";
import {
  SKU_PREVIEW_KEY,
  SKU_SEQUENCE_KEY,
  useSkuSequence,
} from "@/hooks/use-sku-sequence";

// US-3417: where a seller decides what their SKUs look like.
//
// The screen renders nothing it worked out itself. Every SKU on it comes back
// from flipdesk_sku_preview, which runs the same Postgres functions the insert
// trigger runs, so the preview cannot promise a number the trigger will not
// hand out. Every rejection message comes back from flipdesk_sku_validate and
// is shown verbatim rather than reworded here -- two wordings for one rule is
// how a seller ends up unable to act on either.

/** How long to wait after a keystroke before asking the database again. */
const PREVIEW_DEBOUNCE_MS = 300;

type SeedResult = {
  counters: number[];
  matched: string | null;
  match_count: number;
  exhausted?: boolean;
};

/**
 * Pull the human message out of a PostgREST error, whatever shape it took.
 *
 * Exported so it can be asserted directly: US-3416 wrote those strings for a
 * seller to read, and the contract this file signs is that they reach the
 * screen unchanged. A test that only rendered the page could not tell a
 * faithful passthrough from a hard-coded fallback that happened to look right.
 */
export function rpcMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { message?: unknown; details?: unknown; hint?: unknown };
    for (const field of [e.message, e.details, e.hint]) {
      if (typeof field === "string" && field.trim()) return field;
    }
  }
  return "Something went wrong saving your SKU settings.";
}

export function FlipdeskSkuNumberingPage() {
  const user = useAuthStore((s) => s.user);
  const owner = user?.id;
  const queryClient = useQueryClient();
  const { sequence, isExhausted, isLoading } = useSkuSequence(owner);

  const [enabled, setEnabled] = useState(false);
  const [pattern, setPattern] = useState<SkuSegment[]>([]);
  const [counters, setCounters] = useState<number[]>([]);
  const [resetOnDate, setResetOnDate] = useState(false);
  /** Null until the seller has touched anything, so the saved row wins on load. */
  const [touched, setTouched] = useState(false);

  // Load the saved row once. Later refetches must not stomp on an edit in
  // progress, which is what `touched` guards.
  useEffect(() => {
    if (touched || !sequence) return;
    setEnabled(sequence.enabled);
    setPattern(sequence.pattern ?? []);
    setCounters(sequence.counters ?? []);
    setResetOnDate(sequence.reset_on_date_change);
  }, [sequence, touched]);

  const edit = useCallback((next: () => void) => {
    setTouched(true);
    next();
  }, []);

  // ── the debounced preview ────────────────────────────────────────────────
  //
  // The pattern and counters are serialized into the query key rather than
  // passed as objects: a fresh array literal every render changes identity
  // every render, and TanStack Query treats that as a new key each time, which
  // is a refetch loop rather than a cache.
  const patternKey = JSON.stringify(pattern);
  const countersKey = JSON.stringify(counters);
  const [debouncedKey, setDebouncedKey] = useState(`${patternKey}|${countersKey}`);

  useEffect(() => {
    const id = window.setTimeout(
      () => setDebouncedKey(`${patternKey}|${countersKey}`),
      PREVIEW_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(id);
  }, [patternKey, countersKey]);

  const hasCounters = countingSlots(pattern) > 0 && counters.length > 0;

  const preview = useQuery({
    queryKey: ["sku_numbering_preview", owner, debouncedKey],
    enabled: Boolean(owner) && hasCounters,
    // Keep whatever was on screen while the next answer is in flight, so the
    // list does not blink to a spinner on every keystroke.
    placeholderData: (prev) => prev,
    retry: false,
    queryFn: async (): Promise<string[]> => {
      // `as never`: no Functions block in src/types/database.ts, so the
      // generated client types every rpc name and payload as undefined.
      const { data, error } = await supabase.rpc("flipdesk_sku_preview" as never, {
        p_owner: owner as string,
        p_pattern: pattern,
        p_counters: counters,
        p_count: 5,
      } as never);
      if (error) throw error;
      return (data ?? []) as string[];
    },
  });

  /**
   * The validator's own words, surfaced while the seller is still building.
   * flipdesk_sku_preview raises the same message flipdesk_sku_save would, so a
   * bad pattern explains itself before anyone presses Save.
   */
  const problem = preview.isError ? rpcMessage(preview.error) : null;

  // ── the seed ─────────────────────────────────────────────────────────────
  //
  // Asked whenever the PATTERN changes, not when the counters do: it answers
  // "where should this pattern start", and re-asking it after the seller has
  // typed a starting value would fight them for the field.
  const [seed, setSeed] = useState<SeedResult | null>(null);
  const seededFor = useRef<string | null>(null);

  useEffect(() => {
    if (!owner || countingSlots(pattern) === 0) return;
    if (seededFor.current === patternKey) return;
    seededFor.current = patternKey;
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase.rpc("flipdesk_sku_seed" as never, {
        p_owner: owner,
        p_pattern: pattern,
      } as never);
      if (cancelled || error || !data) return;
      const result = data as SeedResult;
      if (cancelled) return;
      setSeed(result);
      // Only pre-fill when the seller has not typed their own starting value.
      setCounters((current) =>
        current.length === 0 || !touched ? result.counters : current,
      );
    })();
    return () => {
      cancelled = true;
    };
    // `touched` is read but deliberately not a dependency: re-running this when
    // the seller first types would re-seed and overwrite what they typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, patternKey, pattern]);

  const applyPreset = (preset: SkuPreset) => {
    edit(() => {
      setPattern(preset.pattern);
      setCounters(preset.counters);
      setResetOnDate(preset.resetOnDateChange);
      // Let the seed re-run for the new pattern and offer its starting point.
      seededFor.current = null;
      setSeed(null);
    });
  };

  const activePresetId = useMemo(() => {
    const current = JSON.stringify(pattern);
    return SKU_PRESETS.find((p) => JSON.stringify(p.pattern) === current)?.id ?? null;
  }, [pattern]);

  const patchSegment = (index: number, next: SkuSegment) => {
    edit(() => {
      setPattern((prev) => {
        const out = prev.map((s, i) => (i === index ? next : s));
        setCounters((c) => fitCounters(out, c));
        return out;
      });
    });
  };

  const addSegment = (kind: SkuSegment["kind"]) => {
    edit(() => {
      setPattern((prev) => {
        const out = [...prev, blankSegment(kind)];
        setCounters((c) => fitCounters(out, c));
        return out;
      });
    });
  };

  const removeSegment = (index: number) => {
    edit(() => {
      setPattern((prev) => {
        const out = prev.filter((_, i) => i !== index);
        setCounters((c) => fitCounters(out, c));
        return out;
      });
    });
  };

  const moveSegment = (index: number, by: -1 | 1) => {
    edit(() => {
      setPattern((prev) => {
        const target = index + by;
        if (target < 0 || target >= prev.length) return prev;
        const out = [...prev];
        const a = out[index];
        const b = out[target];
        if (!a || !b) return prev;
        out[index] = b;
        out[target] = a;
        setCounters((c) => fitCounters(out, c));
        return out;
      });
    });
  };

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("flipdesk_sku_save" as never, {
        p_owner: owner as string,
        p_pattern: pattern,
        p_counters: counters,
        p_enabled: enabled,
        p_reset: resetOnDate,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(
        enabled ? "New items will be numbered for you." : "Automatic numbering is off.",
      );
      setTouched(false);
      void queryClient.invalidateQueries({ queryKey: [SKU_SEQUENCE_KEY, owner] });
      void queryClient.invalidateQueries({ queryKey: [SKU_PREVIEW_KEY, owner] });
    },
    // The message is the database's, shown word for word. US-3416 wrote those
    // strings for a seller to read.
    onError: (error) => toast.error(rpcMessage(error)),
  });

  const previewList = preview.data ?? [];
  const canSave = Boolean(owner) && hasCounters && !problem && !save.isPending;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Hash}
        title="SKU numbering"
        subtitle="Give new items a number automatically, in whatever shape you already use."
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link to="/dashboard/flipdesk/inventory">
              <ChevronLeft className="mr-1 h-4 w-4" />
              Back to inventory
            </Link>
          </Button>
        }
      />

      {isExhausted && (
        <Card>
          <CardContent className="flex items-start gap-3 pt-6">
            <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div className="space-y-1">
              <p className="font-medium">Every number in this pattern has been used.</p>
              <p className="text-sm text-muted-foreground">
                New items are saving without a SKU. Add a digit or a letter below,
                then save.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="flex items-center justify-between gap-4 pt-6">
          <div className="space-y-1">
            <Label htmlFor="sku-enabled" className="text-base">
              Number new items automatically
            </Label>
            <p className="text-sm text-muted-foreground">
              Only fills in the SKU box when you leave it empty. Anything you type
              yourself is kept.
            </p>
          </div>
          <Switch
            id="sku-enabled"
            checked={enabled}
            disabled={isLoading}
            onCheckedChange={(v) => edit(() => setEnabled(v))}
          />
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Start from one of these</h2>
        <div className="space-y-2">
          {SKU_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => applyPreset(preset)}
              aria-pressed={activePresetId === preset.id}
              className={cn(
                "flex w-full items-baseline justify-between gap-4 rounded-xl px-4 py-3 text-left transition-colors",
                activePresetId === preset.id
                  ? "bg-primary/10 ring-1 ring-primary"
                  : "bg-muted/40 hover:bg-muted",
              )}
            >
              <span className="space-y-0.5">
                <span className="block font-medium">{preset.label}</span>
                <span className="block text-sm text-muted-foreground">
                  {preset.blurb}
                </span>
              </span>
              <span className="shrink-0 font-mono text-sm tabular-nums">
                {preset.example}
              </span>
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-medium">Or build your own</h2>
          <div className="flex flex-wrap gap-2">
            {(["text", "number", "letter", "date"] as const).map((kind) => (
              <Button
                key={kind}
                variant="outline"
                size="sm"
                onClick={() => addSegment(kind)}
              >
                <Plus className="mr-1 h-4 w-4" />
                {kind === "text"
                  ? "Text"
                  : kind === "number"
                    ? "Number"
                    : kind === "letter"
                      ? "Letter"
                      : "Date"}
              </Button>
            ))}
          </div>
        </div>

        {pattern.length === 0 ? (
          <p className="rounded-xl bg-muted/40 px-4 py-6 text-center text-sm text-muted-foreground">
            Pick one above, or add a piece to start building.
          </p>
        ) : (
          <div className="space-y-2">
            {pattern.map((segment, index) => (
              <SegmentRow
                key={index}
                segment={segment}
                index={index}
                total={pattern.length}
                onChange={(next) => patchSegment(index, next)}
                onRemove={() => removeSegment(index)}
                onMove={(by) => moveSegment(index, by)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Where it starts</h2>
        <StartingValue
          pattern={pattern}
          counters={counters}
          onChange={(next) => edit(() => setCounters(next))}
        />
        {seed && (
          <p className="text-sm text-muted-foreground">
            {seed.matched
              ? `Your highest matching SKU is ${seed.matched}, so the next one is ${previewList[0] ?? "the value above"}.`
              : "No existing SKUs match this pattern, so numbering starts at the beginning."}
          </p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">What you will get</h2>
        {problem ? (
          <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {problem}
          </p>
        ) : previewList.length === 0 ? (
          <p className="rounded-xl bg-muted/40 px-4 py-6 text-center text-sm text-muted-foreground">
            Add a number or a letter and the next few SKUs will show up here.
          </p>
        ) : (
          <ol className="flex flex-wrap gap-2">
            {previewList.map((sku) => (
              <li
                key={sku}
                className="rounded-lg bg-muted/60 px-3 py-1.5 font-mono text-sm tabular-nums"
              >
                {sku}
              </li>
            ))}
          </ol>
        )}
      </section>

      <div className="flex items-center gap-3">
        <Button onClick={() => save.mutate()} disabled={!canSave}>
          {save.isPending ? "Saving..." : "Save"}
        </Button>
        {touched && (
          <span className="text-sm text-muted-foreground">You have unsaved changes.</span>
        )}
      </div>
    </div>
  );
}

// ── the segment editor ──────────────────────────────────────────────────────

type SegmentRowProps = {
  segment: SkuSegment;
  index: number;
  total: number;
  onChange: (next: SkuSegment) => void;
  onRemove: () => void;
  onMove: (by: -1 | 1) => void;
};

function SegmentRow({
  segment,
  index,
  total,
  onChange,
  onRemove,
  onMove,
}: SegmentRowProps) {
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl bg-muted/40 px-4 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <Label className="text-xs text-muted-foreground">
          {segment.kind === "text"
            ? "Fixed text"
            : segment.kind === "date"
              ? "Today's date"
              : segment.kind === "letter"
                ? "Letter that counts"
                : "Number that counts"}
        </Label>

        {segment.kind === "text" && (
          <Input
            aria-label={`Text for piece ${index + 1}`}
            value={segment.value}
            onChange={(e) => onChange({ kind: "text", value: e.target.value })}
          />
        )}

        {segment.kind === "date" && (
          <Select
            value={segment.format}
            onValueChange={(v) =>
              onChange({ kind: "date", format: v as typeof segment.format })
            }
          >
            <SelectTrigger aria-label={`Date format for piece ${index + 1}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="YY">Two-digit year (26)</SelectItem>
              <SelectItem value="YYYY">Four-digit year (2026)</SelectItem>
              <SelectItem value="MM">Month (09)</SelectItem>
              <SelectItem value="DD">Day (15)</SelectItem>
            </SelectContent>
          </Select>
        )}

        {segment.kind === "letter" && (
          <div className="flex flex-wrap gap-3">
            <Input
              aria-label={`Letters used for piece ${index + 1}`}
              className="flex-1"
              value={segment.alphabet}
              onChange={(e) =>
                onChange({
                  ...segment,
                  alphabet: e.target.value.toUpperCase() || DEFAULT_ALPHABET,
                })
              }
            />
            <Input
              aria-label={`How many letters for piece ${index + 1}`}
              className="w-24"
              type="number"
              min={1}
              max={5}
              value={segment.width}
              onChange={(e) =>
                onChange({ ...segment, width: Number(e.target.value) || 1 })
              }
            />
          </div>
        )}

        {segment.kind === "number" && (
          <div className="flex flex-wrap gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                Digits (0 for none)
              </Label>
              <Input
                aria-label={`Digits for piece ${index + 1}`}
                className="w-28"
                type="number"
                min={0}
                max={9}
                value={segment.width}
                onChange={(e) =>
                  onChange({ ...segment, width: Number(e.target.value) || 0 })
                }
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Lowest</Label>
              <Input
                aria-label={`Lowest number for piece ${index + 1}`}
                className="w-28"
                type="number"
                value={segment.min}
                onChange={(e) =>
                  onChange({ ...segment, min: Number(e.target.value) || 0 })
                }
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Highest</Label>
              <Input
                aria-label={`Highest number for piece ${index + 1}`}
                className="w-32"
                type="number"
                value={segment.max}
                onChange={(e) =>
                  onChange({ ...segment, max: Number(e.target.value) || 0 })
                }
              />
            </div>
          </div>
        )}
      </div>

      <div className="flex gap-1">
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Move piece ${index + 1} earlier`}
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          <ArrowUp className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Move piece ${index + 1} later`}
          disabled={index === total - 1}
          onClick={() => onMove(1)}
        >
          <ArrowDown className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Remove piece ${index + 1}`}
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

// ── the starting value ──────────────────────────────────────────────────────

function StartingValue({
  pattern,
  counters,
  onChange,
}: {
  pattern: readonly SkuSegment[];
  counters: readonly number[];
  onChange: (next: number[]) => void;
}) {
  const counting = pattern.filter(
    (s): s is Extract<SkuSegment, { kind: "number" | "letter" }> =>
      s.kind === "number" || s.kind === "letter",
  );

  if (counting.length === 0) {
    return (
      <p className="rounded-xl bg-muted/40 px-4 py-6 text-center text-sm text-muted-foreground">
        Add a number or a letter and you can set where it starts.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap gap-3">
      {counting.map((segment, i) => (
        <div key={i} className="space-y-1">
          <Label className="text-xs text-muted-foreground">
            {segment.kind === "number" ? "Number starts at" : "Letter starts at"}
          </Label>
          <Input
            aria-label={`Starting value for counting piece ${i + 1}`}
            className="w-32"
            type="number"
            value={counters[i] ?? 0}
            onChange={(e) => {
              const next = [...counters];
              next[i] = Number(e.target.value) || 0;
              onChange(next);
            }}
          />
          {segment.kind === "letter" && (
            <p className="text-xs text-muted-foreground">
              0 is {segment.alphabet.slice(0, 1) || "A"}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
