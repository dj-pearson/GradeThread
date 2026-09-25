import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { useAuth } from "@/hooks/use-auth";
import { useReportSettingsDirty } from "@/hooks/use-settings-dirty";
import { supabase } from "@/lib/supabase";
import { FLIPDESK_PLANS } from "@/lib/constants";
import { aiCapHint, nextAiResetLabel } from "@/lib/ai-limit";
import { usePlanUsage } from "@/hooks/use-plan-usage";
import { useWorkspace } from "@/hooks/use-workspace";
import { toastError } from "@/lib/toast-error";

// The AI tab of /dashboard/settings: usage meter, the enrichment switch and the
// personal monthly cap. Split out of settings.tsx (web-growth action 6).
//
// Each control saves itself: the switch on change, the cap when the field
// loses focus (or on Enter). Usage, limit and plan come from the server's
// billing summary rather than the profile's counter, which has no rollover.
export function AiSettingsTab() {
  const { user, profile, refreshProfile } = useAuth();
  const { isPersonal } = useWorkspace();
  const usage = usePlanUsage();
  const queryClient = useQueryClient();
  // Until the summary arrives (or when it fails) usePlanUsage hands back a
  // "free" plan with a 0 / 0 meter. Showing those as the seller's numbers, or
  // hinting "No effect: your plan already stops at 20" from them, is worse
  // than saying nothing.
  const usageKnown = !usage.isLoading && !usage.isError;

  const [aiEnabled, setAiEnabled] = useState(
    profile?.ai_enrichment_enabled ?? true
  );
  const [aiLimit, setAiLimit] = useState(
    profile?.ai_action_limit != null ? String(profile.ai_action_limit) : ""
  );
  // The last value the server accepted (or is being sent). Set as soon as a
  // save starts, so leaving right after a blur is not "unsaved".
  const [savedLimit, setSavedLimit] = useState(
    profile?.ai_action_limit != null ? String(profile.ai_action_limit) : ""
  );
  const [savingField, setSavingField] = useState<"enabled" | "limit" | null>(null);
  const aiDirty = aiLimit.trim() !== savedLimit;
  useReportSettingsDirty("ai", aiDirty);
  // Follow the profile when it arrives late or changes elsewhere, but never
  // over typing that has not been saved yet.
  const aiDirtyRef = useRef(aiDirty);
  aiDirtyRef.current = aiDirty;
  const profileEnabled = profile?.ai_enrichment_enabled ?? true;
  const profileLimit =
    profile?.ai_action_limit != null ? String(profile.ai_action_limit) : "";
  useEffect(() => {
    setAiEnabled(profileEnabled);
    if (aiDirtyRef.current) return;
    setAiLimit(profileLimit);
    setSavedLimit(profileLimit);
  }, [profileEnabled, profileLimit]);

  // The allowance belongs to the workspace owner. Inside someone else's
  // workspace the usage shown is theirs, and this member's own cap would not
  // apply to it, so the tab is read-only there.
  const readOnly = !isPersonal;

  const planAiLimit = FLIPDESK_PLANS[usage.plan]?.aiActionsPerMonth ?? 0;
  const aiUsed = usage.aiActions.used;
  const effectiveAiLimit = usage.aiActions.limit;
  const aiUnlimited = usage.aiActions.unlimited;
  const aiPct = Math.min(100, usage.aiActions.pct);

  async function writeAi(
    field: "enabled" | "limit",
    patch: { ai_enrichment_enabled?: boolean; ai_action_limit?: number | null },
  ): Promise<boolean> {
    if (!user) return false;
    setSavingField(field);
    try {
      const { error } = await supabase
        .from("users")
        .update(patch as never)
        .eq("id", user.id);
      if (error) throw error;
      await refreshProfile();
      // The meter's limit comes from the billing summary, which would
      // otherwise show the old cap until its next refetch.
      void queryClient.invalidateQueries({ queryKey: ["billing_summary"] });
      return true;
    } catch (err) {
      toastError(err, "Failed to save AI settings.");
      return false;
    } finally {
      setSavingField(null);
    }
  }

  async function handleToggle(next: boolean) {
    const previous = aiEnabled;
    setAiEnabled(next);
    const ok = await writeAi("enabled", { ai_enrichment_enabled: next });
    if (!ok) setAiEnabled(previous);
    else toast.success(next ? "AI assistant turned on." : "AI assistant turned off.");
  }

  async function saveLimit() {
    const trimmed = aiLimit.trim();
    if (trimmed === savedLimit) return;
    // US-1631: a blank field clears the personal cap (plan default). Otherwise
    // require a whole number — previously `parseInt("abc") || 0` silently saved a
    // HARD 0 cap (blocking ALL AI actions) on a typo. "0" is still allowed as an
    // intentional "disable AI" cap.
    if (trimmed !== "" && !/^\d+$/.test(trimmed)) {
      toast.error(
        "Enter a whole number for the AI action cap, or leave it blank for the plan default.",
      );
      return;
    }
    const previous = savedLimit;
    setSavedLimit(trimmed);
    const limitVal = trimmed === "" ? null : Number.parseInt(trimmed, 10);
    const ok = await writeAi("limit", { ai_action_limit: limitVal });
    if (!ok) setSavedLimit(previous);
    else toast.success("AI action limit saved.");
  }

  return (
    <>
          {/* AI Item Assistant Section */}
          <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            AI Item Assistant
          </CardTitle>
          <CardDescription>
            AI-assisted cataloging for FlipDesk — fills item fields and writes
            listing copy from your descriptions and photos.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {readOnly && (
            <p className="rounded-lg bg-muted p-3 text-sm">
              AI allowance belongs to the workspace owner. Switch to your own
              workspace to change these settings.
            </p>
          )}
          {/* Usage meter */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">This month's AI usage</span>
              <span className="text-muted-foreground">
                {usage.isLoading
                  ? "Loading…"
                  : usage.isError
                    ? "Couldn't load usage"
                    : aiUnlimited
                    ? `${aiUsed} actions used`
                    : `${aiUsed} / ${effectiveAiLimit} actions`}
              </span>
            </div>
            {!aiUnlimited && usageKnown && (
              <Progress value={aiPct} aria-label="AI actions used this month" />
            )}
            <p className="text-xs text-muted-foreground">
              Allowance resets on {nextAiResetLabel()} (UTC).
              {usageKnown && aiUnlimited && " Your plan includes unlimited AI actions."}
            </p>
          </div>

          <Separator />

          {/* Enable toggle */}
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <p className="text-sm font-medium">Enable AI enrichment</p>
              {/* US-2442: this used to name a "listing-copy" button that does
                  not exist on the web. It exists on iOS and the edge route is
                  live, but no web surface has called it for some time — so the
                  sentence was describing a control the reader could not find,
                  which reads as the setting being broken rather than the copy
                  being wrong.
                  Named by what the web ACTUALLY has, and deliberately not
                  exhaustively: the toggle gates every /api/flipdesk/ai/* route
                  server-side (flipdesk-ai.ts checks ai_enrichment_enabled before
                  any of them), so listing an incomplete set of buttons is what
                  made this drift in the first place. Whether the web should
                  regain a listing-copy button is US-2442 AC1 and is a product
                  call, not a copy fix. */}
              <p className="text-xs text-muted-foreground">
                When off, every AI feature is disabled account-wide — AI Fill,
                the composer's rewrite tools, and photo analysis.
              </p>
            </div>
            <Switch
              aria-label="Enable AI enrichment"
              checked={aiEnabled}
              disabled={readOnly || savingField === "enabled"}
              onCheckedChange={(v) => void handleToggle(v)}
            />
          </div>

          {/* Custom monthly limit */}
          <div className="space-y-1.5">
            <Label htmlFor="ai-limit">Monthly action limit</Label>
            <Input
              id="ai-limit"
              type="number"
              min="0"
              value={aiLimit}
              onChange={(e) => setAiLimit(e.target.value)}
              onBlur={() => void saveLimit()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveLimit();
              }}
              disabled={readOnly || savingField === "limit"}
              aria-describedby="ai-limit-hint"
              placeholder={
                !usageKnown
                  ? "Plan default"
                  : planAiLimit < 0
                    ? "Unlimited (plan default)"
                    : `${planAiLimit} (plan default)`
              }
              className="max-w-xs"
            />
            <p id="ai-limit-hint" className="text-xs text-muted-foreground">
              {savingField === "limit" && (
                <Loader2 className="mr-1 inline h-3 w-3 animate-spin" aria-hidden="true" />
              )}
              {usageKnown
                ? aiCapHint(aiLimit, planAiLimit)
                : "Optional. A number lowers your monthly AI allowance; blank uses your plan's."}{" "}
              Saves when you leave the field.
            </p>
          </div>
        </CardContent>
      </Card>
    </>
  );
}
