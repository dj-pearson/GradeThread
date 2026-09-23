import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/lib/supabase";
import { FLIPDESK_PLANS, flipdeskPlanForLegacy, type PlanKey } from "@/lib/constants";
import { effectiveAiLimit as computeEffectiveAiLimit } from "@/lib/ai-limit";
import { toastError } from "@/lib/toast-error";

function nextResetLabel(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).toLocaleDateString(
    "en-US",
    { month: "long", day: "numeric" }
  );
}

// The AI tab of /dashboard/settings: usage meter, the enrichment switch and the
// personal monthly cap. Split out of settings.tsx (web-growth action 6).
export function AiSettingsTab() {
  const { user, profile, refreshProfile } = useAuth();

  const [aiEnabled, setAiEnabled] = useState(
    profile?.ai_enrichment_enabled ?? true
  );
  const [aiLimit, setAiLimit] = useState(
    profile?.ai_action_limit != null ? String(profile.ai_action_limit) : ""
  );
  const [savingAi, setSavingAi] = useState(false);

  // FlipDesk plan drives the AI allowance (US-202). Fall back to the legacy
  // US-2365: the un-backfilled fallback now translates the legacy column
  // explicitly instead of going through the deprecated PLANS shim. Same
  // numbers — the shim only ever derived them from FLIPDESK_PLANS — but the
  // translation is visible rather than hidden behind an alias.
  const flipdeskPlan = profile?.flipdesk_plan ??
    flipdeskPlanForLegacy((profile?.plan ?? "free") as PlanKey);
  const planAiLimit = FLIPDESK_PLANS[flipdeskPlan].aiActionsPerMonth;
  // US-1631: same min-of-plan-and-user-cap semantics as billing / usage meters
  // (previously `userLimit ?? plan`, which disagreed when a user's cap exceeded
  // the plan).
  const effectiveAiLimit = computeEffectiveAiLimit(planAiLimit, profile?.ai_action_limit ?? null);
  const aiUsed = profile?.ai_actions_used_this_month ?? 0;
  const aiUnlimited = effectiveAiLimit < 0;
  const aiPct =
    !aiUnlimited && effectiveAiLimit > 0
      ? Math.min(100, Math.round((aiUsed / effectiveAiLimit) * 100))
      : 0;

  async function handleSaveAiSettings() {
    if (!user) return;
    const trimmed = aiLimit.trim();
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
    const limitVal = trimmed === "" ? null : Number.parseInt(trimmed, 10);
    setSavingAi(true);
    try {
      const { error } = await supabase
        .from("users")
        .update({
          ai_enrichment_enabled: aiEnabled,
          ai_action_limit: limitVal,
        } as never)
        .eq("id", user.id);
      if (error) throw error;
      await refreshProfile();
      toast.success("AI assistant settings saved.");
    } catch (err) {
      toastError(err, "Failed to save AI settings.");
    } finally {
      setSavingAi(false);
    }
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
          {/* Usage meter */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">This month's AI usage</span>
              <span className="text-muted-foreground">
                {aiUnlimited
                  ? `${aiUsed} actions used`
                  : `${aiUsed} / ${effectiveAiLimit} actions`}
              </span>
            </div>
            {!aiUnlimited && <Progress value={aiPct} />}
            <p className="text-xs text-muted-foreground">
              Allowance resets on {nextResetLabel()}.
              {aiUnlimited && " Your plan includes unlimited AI actions."}
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
            <Switch aria-label="Enable AI enrichment" checked={aiEnabled} onCheckedChange={setAiEnabled} />
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
              placeholder={
                planAiLimit < 0
                  ? "Unlimited (plan default)"
                  : `${planAiLimit} (plan default)`
              }
              className="max-w-xs"
            />
            <p className="text-xs text-muted-foreground">
              Optional. Set a lower number to cap your own AI spend. Leave
              blank to use your plan's allowance.
            </p>
          </div>

          <Button onClick={handleSaveAiSettings} disabled={savingAi}>
            {savingAi && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save AI Settings
          </Button>
        </CardContent>
      </Card>
    </>
  );
}
