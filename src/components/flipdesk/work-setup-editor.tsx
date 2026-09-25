// Worth My Time (WMT-06): the seller's setup, edited where the plan is.
//
// The page used to say "Change your setup" and link to the inventory screen,
// which has no setup controls, and nothing in the app wrote available_tools at
// all. So the default camera-only toolset was permanent, and every measuring
// and packing job was dropped from every plan without a word.
//
// ONE FIELD PER SAVE. Each control sends a PATCH naming only its own column,
// which the route now writes as-is (WMT-01), so a tools change can never reset
// the hourly target and two quick taps cannot overwrite each other.

import { useId, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toastError } from "@/lib/toast-error";
import {
  useSaveWorkPreferences,
  type WorkPreferences,
} from "@/hooks/use-planner";
import { WORK_TOOL_LABELS, WORK_TOOL_ORDER } from "@/lib/work-setup-copy";

export interface WorkSetupEditorProps {
  prefs: WorkPreferences | undefined;
  /** Fired after a change lands, so an on-screen plan can say it is stale. */
  onChanged?: () => void;
}

export function WorkSetupEditor({ prefs, onChanged }: WorkSetupEditorProps) {
  const save = useSaveWorkPreferences();
  const id = useId();
  // A member without rights to the owner's setup gets a 403. After the first
  // one the controls stop offering a change that cannot land.
  const [readOnly, setReadOnly] = useState(false);
  const [target, setTarget] = useState("");
  const [targetError, setTargetError] = useState<string | null>(null);

  const context = prefs?.workContext ?? "home";
  const tools = prefs?.availableTools ?? ["camera"];
  const disabled = readOnly || save.isPending || !prefs;

  /** True when the change landed. */
  async function patch(body: Record<string, unknown>): Promise<boolean> {
    try {
      await save.mutateAsync(body);
      onChanged?.();
      return true;
    } catch (err) {
      if ((err as { status?: number }).status === 403) {
        setReadOnly(true);
        return false;
      }
      toastError(err, "Couldn't save your setup.");
      return false;
    }
  }

  function toggleTool(tool: string) {
    const next = tools.includes(tool)
      ? tools.filter((t) => t !== tool)
      : [...tools, tool];
    void patch({ available_tools: next });
  }

  function saveTarget(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(target.replace(/[$,\s]/g, ""));
    if (target.trim() === "" || !Number.isFinite(n) || n < 0) {
      setTargetError("Type an amount in dollars, like 20.");
      return;
    }
    setTargetError(null);
    // Cleared only when it saved: a failed save keeps what the seller typed.
    void patch({ hourly_target_amount: n }).then((ok) => {
      if (ok) setTarget("");
    });
  }

  return (
    <div id="wmt-setup" className="space-y-3 border-t pt-3">
      <p className="text-sm font-medium">Your setup</p>

      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground" id={`${id}-where`}>
          Where are you working?
        </p>
        <div role="group" aria-labelledby={`${id}-where`} className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={context === "home" ? "default" : "outline"}
            aria-pressed={context === "home"}
            disabled={disabled}
            onClick={() => context !== "home" && void patch({ work_context: "home" })}
          >
            At home
          </Button>
          <Button
            size="sm"
            variant={context === "phone_only" ? "default" : "outline"}
            aria-pressed={context === "phone_only"}
            disabled={disabled}
            onClick={() =>
              context !== "phone_only" && void patch({ work_context: "phone_only" })}
          >
            Away, phone only
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground" id={`${id}-tools`}>
          What do you have to hand?
        </p>
        <div role="group" aria-labelledby={`${id}-tools`} className="flex flex-wrap gap-2">
          {WORK_TOOL_ORDER.map((tool) => {
            const on = tools.includes(tool);
            return (
              <Button
                key={tool}
                size="sm"
                variant={on ? "default" : "outline"}
                aria-pressed={on}
                disabled={disabled}
                onClick={() => toggleTool(tool)}
              >
                {WORK_TOOL_LABELS[tool]}
              </Button>
            );
          })}
        </div>
      </div>

      <form className="space-y-1.5" onSubmit={saveTarget} noValidate>
        <Label htmlFor={`${id}-target`} className="text-xs text-muted-foreground">
          Hourly target (optional)
        </Label>
        <p className="text-xs">
          {prefs?.hourlyTargetSet && prefs.hourlyTargetAmount != null
            ? `Now $${prefs.hourlyTargetAmount.toFixed(2)} an hour.`
            : "Not set. We won't compare jobs against a rate."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Input
            id={`${id}-target`}
            className="w-24"
            inputMode="decimal"
            placeholder="20"
            value={target}
            disabled={disabled}
            aria-invalid={targetError != null}
            aria-describedby={targetError ? `${id}-target-error` : undefined}
            onChange={(e) => setTarget(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={disabled || target.trim() === ""}>
            Save
          </Button>
          {prefs?.hourlyTargetSet && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => void patch({ hourly_target_amount: null })}
            >
              Clear it
            </Button>
          )}
        </div>
        {targetError && (
          <p id={`${id}-target-error`} className="text-xs text-destructive">
            {targetError}
          </p>
        )}
      </form>

      {readOnly && (
        <p role="status" className="text-xs text-muted-foreground">
          Only the workspace owner can change this setup.
        </p>
      )}
      {save.isPending && (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> Saving
        </p>
      )}
    </div>
  );
}
