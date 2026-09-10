import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import {
  DEFAULT_SOURCING_COST_CENTS,
  SOURCING_COST_FIELDS,
  type SourcingCostKey,
  centsToCostInput,
  parseCostInput,
} from "@/components/flipdesk/sourcing-cost-fields";

// US-2851: the margin you are actually sourcing to.
//
// Scout's "don't pay more than" number is meaningless without a target return,
// and FlipDesk had nowhere to put one: the autolister's "floor at % margin" is
// typed fresh into a bulk action and thrown away, and automation rules carry a
// per-rule offer threshold, not a sourcing goal.
//
// Blank means the product default (30%), which is the same threshold that
// already decides whether Scout calls an item a maybe. Saying so on screen
// matters: a seller who leaves this empty should know what they are getting,
// not discover it by reverse-engineering a ceiling.
//
// US-3193: AND THE COSTS THAT CEILING SUBTRACTS. Migration 00770 added
// sourcing_shipping_cost_cents, sourcing_supplies_cost_cents and
// sourcing_grading_cost_cents; the edge read all three from the day they
// landed, and nothing in the product could set them. So the whole promise that
// the figures are the SELLER'S — that a seller shipping heavy coats or buying
// mailers in bulk gets a ceiling built on their own numbers — was true for
// nobody, and every account silently ran on the code defaults. The four fields
// belong in one block and save in one upsert because they are one row and one
// decision: what you sell for, minus what it costs you to send it.
//
// RLS on flipdesk_settings scopes the row to the signed-in user (00134), so
// this reads and writes with the plain client and no explicit filter.

/** Mirrors DECISION_MAYBE_ROI in services/edge-functions/src/lib/scout-decision.ts. */
export const DEFAULT_SOURCING_TARGET_PCT = 30;
/** Mirrors the CHECK in migration 00666. */
export const MAX_SOURCING_TARGET_PCT = 1000;

/** The four columns this block owns, as they come back from the row. */
interface SourcingSettings {
  sourcing_target_roi_pct: number | null;
  sourcing_shipping_cost_cents: number | null;
  sourcing_supplies_cost_cents: number | null;
  sourcing_grading_cost_cents: number | null;
}

type CostDrafts = Record<SourcingCostKey, string>;

const EMPTY_COSTS: CostDrafts = { shipping: "", supplies: "", grading: "" };

export function SourcingTargetSetting() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [draft, setDraft] = useState("");
  const [costDrafts, setCostDrafts] = useState<CostDrafts>(EMPTY_COSTS);
  const [saving, setSaving] = useState(false);

  const { data: stored } = useQuery({
    queryKey: ["sourcing_target", user?.id],
    enabled: Boolean(user?.id),
    queryFn: async (): Promise<SourcingSettings | null> => {
      const { data, error } = await supabase
        .from("flipdesk_settings")
        .select(
          "sourcing_target_roi_pct, sourcing_shipping_cost_cents, sourcing_supplies_cost_cents, sourcing_grading_cost_cents",
        )
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      return (data as SourcingSettings | null) ?? null;
    },
  });

  useEffect(() => {
    setDraft(
      stored?.sourcing_target_roi_pct == null
        ? ""
        : String(stored.sourcing_target_roi_pct),
    );
    setCostDrafts({
      shipping: centsToCostInput(stored?.sourcing_shipping_cost_cents),
      supplies: centsToCostInput(stored?.sourcing_supplies_cost_cents),
      grading: centsToCostInput(stored?.sourcing_grading_cost_cents),
    });
  }, [stored]);

  async function save() {
    if (!user) return;
    const trimmed = draft.trim();
    // Empty is a real choice, not an error: it means "use the default".
    let value: number | null = null;
    if (trimmed !== "") {
      const n = Number.parseInt(trimmed, 10);
      if (!Number.isFinite(n) || n < 0 || n > MAX_SOURCING_TARGET_PCT) {
        toast.error(`Enter a whole percent between 0 and ${MAX_SOURCING_TARGET_PCT}, or leave it blank.`);
        return;
      }
      value = n;
    }

    // US-3193: every cost line is validated BEFORE anything is written, so a
    // bad third field cannot leave the first two saved and the row half-edited.
    const costs: Record<string, number | null> = {};
    for (const field of SOURCING_COST_FIELDS) {
      const parsed = parseCostInput(costDrafts[field.key]);
      if (!parsed.ok) {
        toast.error(`${field.label}: ${parsed.error}`);
        return;
      }
      costs[field.column] = parsed.cents;
    }

    setSaving(true);
    try {
      const { error } = await supabase
        .from("flipdesk_settings")
        .upsert(
          { user_id: user.id, sourcing_target_roi_pct: value, ...costs } as never,
          { onConflict: "user_id" },
        );
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["sourcing_target", user.id] });
      toast.success(
        value == null
          ? `Using the default ${DEFAULT_SOURCING_TARGET_PCT}% target.`
          : `Sourcing to a ${value}% target.`,
      );
    } catch (err) {
      toastError(err, "Couldn't save your target.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border p-3 text-sm">
      <div className="space-y-0.5">
        <p className="font-medium">Your sourcing target</p>
        <p className="text-xs text-muted-foreground">
          The return on cost you buy for. Scout uses it to work out the most you
          should pay for an item at the condition it is in. Leave it blank to use
          the default {DEFAULT_SOURCING_TARGET_PCT}%.
        </p>
      </div>
      <div className="flex items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="sourcing-target" className="text-xs">
            Target return
          </Label>
          <div className="flex items-center gap-1">
            <Input
              id="sourcing-target"
              inputMode="numeric"
              className="w-24"
              placeholder={String(DEFAULT_SOURCING_TARGET_PCT)}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <span className="text-muted-foreground">%</span>
          </div>
        </div>
      </div>

      <div className="space-y-2 border-t pt-3">
        <div className="space-y-0.5">
          <p className="font-medium">What it costs you to sell it</p>
          <p className="text-xs text-muted-foreground">
            Scout takes these off before it works out your maximum buy price, so
            the number on screen is one you can actually pay. Leave a field blank
            to use our figure for it.
          </p>
        </div>
        <div className="flex flex-wrap items-start gap-4">
          {SOURCING_COST_FIELDS.map((field) => (
            <div key={field.key} className="space-y-1">
              <Label htmlFor={field.inputId} className="text-xs">
                {field.label}
              </Label>
              <div className="flex items-center gap-1">
                <span className="text-muted-foreground">$</span>
                <Input
                  id={field.inputId}
                  inputMode="decimal"
                  className="w-24"
                  placeholder={centsToCostInput(
                    DEFAULT_SOURCING_COST_CENTS[field.key],
                  )}
                  value={costDrafts[field.key]}
                  onChange={(e) =>
                    setCostDrafts((prev) => ({ ...prev, [field.key]: e.target.value }))}
                />
              </div>
              <p className="max-w-[15rem] text-xs text-muted-foreground">{field.help}</p>
            </div>
          ))}
        </div>
      </div>

      <Button size="sm" variant="outline" disabled={saving} onClick={() => void save()}>
        Save
      </Button>
    </div>
  );
}
