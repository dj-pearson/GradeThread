import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { track } from "@/lib/analytics";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuthStore } from "@/stores/auth-store";
import { usePlanPickerStore } from "@/stores/plan-picker-store";
import {
  usePlanUsage,
  suggestedPlanForCap,
  CAP_FIELDS,
  CAP_LABELS,
  type CapUsage,
  type PlanCapKind,
} from "@/hooks/use-plan-usage";
import { FLIPDESK_PLANS } from "@/lib/constants";

// ── UsageAlertWatcher (US-209) ──────────────────────────────────
//
// Mounted once inside the dashboard layout. Watches the four plan caps via
// usePlanUsage and surfaces a dismissible, non-blocking upgrade toast when a
// cap crosses one of the user's configured thresholds (default 80%; Settings
// offers 50/80/95). Each (cap, threshold) fires at most once per calendar
// month, deduped against localStorage (instant) AND the server's last_warning
// ledger (cross-device). The toast CTA opens the plan picker pre-scrolled to
// the next-higher tier (US-212).
//
// This is the proactive, poll-the-cache counterpart to the reactive
// X-Plan-Warning header toast in edge-fetch.ts: that one fires on the request
// that bumped usage past 80%; this one catches caps already over threshold
// when the dashboard loads (e.g. listings created on another device).

function currentMonthUtc(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function dedupKey(userId: string, cap: PlanCapKind, threshold: number): string {
  return `gt_usage_alert_${userId}_${cap}_${threshold}`;
}

function alreadyFiredThisMonth(
  userId: string,
  cap: PlanCapKind,
  threshold: number,
  serverLedger: Record<string, string>,
  month: string,
): boolean {
  if (serverLedger[`${cap}:${threshold}`] === month) return true;
  try {
    return localStorage.getItem(dedupKey(userId, cap, threshold)) === month;
  } catch {
    return false;
  }
}

// The highest configured threshold the cap has crossed (e.g. thresholds
// [50,80,95] at 85% → 80). Returns null when below every threshold or the cap
// is unlimited / has no real limit.
function crossedThreshold(usage: CapUsage, thresholds: number[]): number | null {
  if (usage.unlimited || usage.limit <= 0) return null;
  const crossed = thresholds
    .filter((t) => usage.pct >= t)
    .sort((a, b) => b - a);
  return crossed[0] ?? null;
}

export function UsageAlertWatcher() {
  const usage = usePlanUsage();
  const userId = useAuthStore((s) => s.user?.id) ?? null;
  const showPicker = usePlanPickerStore((s) => s.show);
  // Guards against re-firing within the same session before localStorage/server
  // round-trips settle (React strict-mode double effects, rapid re-renders).
  const firedThisSession = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (usage.isLoading || !userId) return;
    // Free is the entry plan — its caps are real, so we still warn (the user
    // upgrades from Free). No special-casing needed beyond unlimited skips.
    const month = currentMonthUtc();

    for (const { kind, field } of CAP_FIELDS) {
      const capUsage = usage[field] as CapUsage;
      const threshold = crossedThreshold(capUsage, usage.thresholds);
      if (threshold === null) continue;

      const sessionKey = `${kind}:${threshold}:${month}`;
      if (firedThisSession.current.has(sessionKey)) continue;
      if (alreadyFiredThisMonth(userId, kind, threshold, usage.lastWarning, month)) {
        continue;
      }
      firedThisSession.current.add(sessionKey);

      const suggestedPlan = suggestedPlanForCap(kind, capUsage.limit + 1);
      const suggestedLimitRaw = capLimitFor(kind, suggestedPlan);
      const suggestedLimit =
        suggestedLimitRaw < 0 ? "unlimited" : String(suggestedLimitRaw);

      track("upgrade.trigger.soft", {
        cap: kind,
        pct: capUsage.pct / 100,
        threshold: threshold / 100,
        plan: usage.plan,
        suggestedPlan,
      });

      toast.warning(
        `You've used ${capUsage.pct}% of your ${CAP_LABELS[kind]}`,
        {
          id: `usage_alert_${kind}`,
          description: `${capUsage.used} of ${capUsage.limit} used — upgrade to ${FLIPDESK_PLANS[suggestedPlan].name} for ${suggestedLimit}.`,
          duration: 8000,
          action: {
            label: "Upgrade",
            onClick: () => showPicker({ highlightPlan: suggestedPlan }),
          },
        },
      );

      // Persist dedup: localStorage (instant) + server ledger (cross-device).
      try {
        localStorage.setItem(dedupKey(userId, kind, threshold), month);
      } catch {
        /* private mode — server ledger still dedupes */
      }
      void edgeFetch("/api/payments/usage-alerts/fired", {
        method: "POST",
        json: { cap: kind, threshold },
        silentGate: true,
      }).catch(() => {
        /* best-effort — localStorage already guards this device */
      });
    }
  }, [usage, userId, showPicker]);

  return null;
}

// Cap limit a given plan grants, for the toast copy ("upgrade to Pro for 1000").
function capLimitFor(kind: PlanCapKind, plan: keyof typeof FLIPDESK_PLANS): number {
  const conf = FLIPDESK_PLANS[plan];
  switch (kind) {
    case "activeListings":
      return conf.activeListingCap;
    case "aiActions":
      return conf.aiActionsPerMonth;
    case "includedGrades":
      return conf.includedStandardGradesPerMonth;
    case "marketplaces":
      return conf.marketplacesCap;
  }
}
