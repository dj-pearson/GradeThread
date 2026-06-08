import { useEffect, useMemo, useState } from "react";
import { Sparkles, AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  recordAiAcceptance,
  type AiExtractResponse,
} from "@/hooks/use-ai-extract";

export interface AcceptedField {
  field: string;
  value: string;
  source: string;
  confidence: number;
}

interface AiFillPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  result: AiExtractResponse | null;
  /** Current form/record values, keyed by field — used to flag overwrites. */
  currentValues: Record<string, string>;
  /** Optional display labels per field key. */
  fieldLabels?: Record<string, string>;
  onApply: (accepted: AcceptedField[]) => void;
}

function humanize(key: string): string {
  return key
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function confidenceTier(c: number): {
  label: string;
  className: string;
} {
  if (c >= 0.8) {
    return {
      label: "High",
      className: "border-green-200 bg-green-100 text-green-800",
    };
  }
  if (c >= 0.5) {
    return {
      label: "Med",
      className: "border-yellow-200 bg-yellow-100 text-yellow-800",
    };
  }
  return {
    label: "Low",
    className: "border-red-200 bg-red-100 text-red-800",
  };
}

export function AiFillPanel({
  open,
  onOpenChange,
  result,
  currentValues,
  fieldLabels = {},
  onApply,
}: AiFillPanelProps) {
  const conflictFields = useMemo(
    () => new Set((result?.conflicts ?? []).map((c) => c.field)),
    [result]
  );

  // Suggestion rows, excluding fields that are surfaced as conflicts.
  const rows = useMemo(() => {
    if (!result) return [];
    return Object.entries(result.suggestions).filter(
      ([field]) => !conflictFields.has(field)
    );
  }, [result, conflictFields]);

  const [accept, setAccept] = useState<Record<string, boolean>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [conflictPick, setConflictPick] = useState<
    Record<string, "text" | "photo">
  >({});

  // Re-initialise whenever a fresh extraction result arrives.
  useEffect(() => {
    if (!result) return;
    const nextAccept: Record<string, boolean> = {};
    const nextValues: Record<string, string> = {};
    for (const [field, sug] of Object.entries(result.suggestions)) {
      nextValues[field] = sug.value;
      // Default-on only when the field is currently empty — AI never
      // silently overwrites something the user already filled.
      nextAccept[field] = !(currentValues[field] ?? "").trim();
    }
    const nextPick: Record<string, "text" | "photo"> = {};
    for (const conflict of result.conflicts) {
      nextPick[conflict.field] = "photo";
    }
    setAccept(nextAccept);
    setValues(nextValues);
    setConflictPick(nextPick);
  }, [result, currentValues]);

  if (!result) return null;

  const hasAnything = rows.length > 0 || result.conflicts.length > 0;

  function acceptAll() {
    setAccept((prev) => {
      const next = { ...prev };
      for (const [field] of rows) next[field] = true;
      return next;
    });
  }

  function handleApply() {
    if (!result) return;
    const accepted: AcceptedField[] = [];

    for (const [field, sug] of rows) {
      if (!accept[field]) continue;
      const value = (values[field] ?? "").trim();
      if (!value) continue;
      accepted.push({
        field,
        value,
        source: sug.source,
        confidence: sug.confidence,
      });
    }

    for (const conflict of result.conflicts) {
      const pick = conflictPick[conflict.field] ?? "photo";
      const value =
        pick === "photo" ? conflict.photo_value : conflict.text_value;
      if (value.trim()) {
        accepted.push({
          field: conflict.field,
          value: value.trim(),
          source: pick === "photo" ? "photo" : "text",
          confidence: 0.6,
        });
      }
    }

    if (result.log_id) {
      const acceptedMap: Record<string, string> = {};
      for (const a of accepted) acceptedMap[a.field] = a.value;
      void recordAiAcceptance(result.log_id, acceptedMap);
    }

    onApply(accepted);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Review AI suggestions
          </DialogTitle>
          <DialogDescription>
            {hasAnything
              ? "Accept the suggestions you want. Nothing is saved until you Apply."
              : "Nothing to extract — add a description or photos and try again."}
          </DialogDescription>
        </DialogHeader>

        {result.condition_summary && (
          <div className="rounded-md bg-muted/50 p-3 text-sm">
            <span className="font-medium">Condition summary: </span>
            {result.condition_summary}
          </div>
        )}

        {/* Conflicts first — they need an explicit decision. */}
        {result.conflicts.length > 0 && (
          <div className="space-y-2">
            <p className="flex items-center gap-1.5 text-sm font-medium text-amber-700 dark:text-amber-500">
              <AlertTriangle className="h-4 w-4" />
              Conflicting values — pick one
            </p>
            {result.conflicts.map((conflict) => {
              const pick = conflictPick[conflict.field] ?? "photo";
              return (
                <div
                  key={conflict.field}
                  className="rounded-lg border p-3"
                >
                  <p className="mb-2 text-sm font-medium">
                    {fieldLabels[conflict.field] ??
                      humanize(conflict.field)}
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        setConflictPick((p) => ({
                          ...p,
                          [conflict.field]: "photo",
                        }))
                      }
                      className={cn(
                        "rounded-md border-2 p-2 text-left text-sm",
                        pick === "photo"
                          ? "border-primary bg-primary/5"
                          : "border-border"
                      )}
                    >
                      <span className="block text-xs text-muted-foreground">
                        From photo
                      </span>
                      {conflict.photo_value || "—"}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setConflictPick((p) => ({
                          ...p,
                          [conflict.field]: "text",
                        }))
                      }
                      className={cn(
                        "rounded-md border-2 p-2 text-left text-sm",
                        pick === "text"
                          ? "border-primary bg-primary/5"
                          : "border-border"
                      )}
                    >
                      <span className="block text-xs text-muted-foreground">
                        From text
                      </span>
                      {conflict.text_value || "—"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Suggestion rows */}
        {rows.length > 0 && (
          <div className="space-y-2">
            {rows.map(([field, sug]) => {
              const tier = confidenceTier(sug.confidence);
              const current = (currentValues[field] ?? "").trim();
              return (
                <div
                  key={field}
                  className="flex flex-wrap items-center gap-3 rounded-lg border p-3"
                >
                  <Switch
                    checked={accept[field] ?? false}
                    onCheckedChange={(v) =>
                      setAccept((prev) => ({ ...prev, [field]: v }))
                    }
                    aria-label={`Accept ${humanize(field)}`}
                  />
                  <div className="min-w-[5rem] text-sm font-medium">
                    {fieldLabels[field] ?? humanize(field)}
                  </div>
                  {field === "description" ? (
                    // The AI-generated description is a multi-line paragraph —
                    // give it room to read/edit instead of a 1-line input.
                    <Textarea
                      value={values[field] ?? ""}
                      onChange={(e) =>
                        setValues((prev) => ({
                          ...prev,
                          [field]: e.target.value,
                        }))
                      }
                      rows={4}
                      className="w-full min-w-[8rem]"
                    />
                  ) : (
                    <Input
                      value={values[field] ?? ""}
                      onChange={(e) =>
                        setValues((prev) => ({
                          ...prev,
                          [field]: e.target.value,
                        }))
                      }
                      className="h-8 flex-1 min-w-[8rem]"
                    />
                  )}
                  <Badge variant="outline" className={tier.className}>
                    {tier.label}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {sug.source}
                  </span>
                  {current && (
                    <span className="w-full text-xs text-amber-700 dark:text-amber-500">
                      Replaces current value: “{current}”
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <div className="flex gap-2">
            {rows.length > 0 && (
              <Button variant="outline" size="sm" onClick={acceptAll}>
                Accept all
              </Button>
            )}
            <Button size="sm" onClick={handleApply} disabled={!hasAnything}>
              Apply
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
