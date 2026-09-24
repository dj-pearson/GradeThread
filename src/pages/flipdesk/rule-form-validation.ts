// Inline checks for the two rule forms on the Pricing page. Each returns the
// first problem as a sentence, or null when the form can be saved. The forms
// disable Save while there is one, instead of turning a blank "days" box into 1
// (which cut nearly every listing) or a 150% drop into 90%.

import {
  AUTOMATION_BOUNDS,
  MAX_WATCHER_OFFER_PCT,
  MIN_WATCHER_OFFER_PCT,
} from "@/hooks/use-automations";
import { REPRICE_RULE_BOUNDS } from "@/hooks/use-repricing";

/** A whole number within [min, max], or null when blank or not a number. */
function wholeIn(v: string, min: number, max: number): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function numberIn(v: string, min: number, max: number): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/** Triggers that ARE their own action: no "Then", no scope, no cooldown. */
export const SELF_ACTING_TRIGGERS = new Set([
  "offer_threshold",
  "return_threshold",
  "markdown_schedule",
]);

export interface AutomationFormValues {
  name: string;
  triggerType: string;
  triggerNeedsDays: boolean;
  triggerDays: string;
  cooldownDays: string;
  actionType: string;
  /** Null when the action takes no percent. */
  actionPctMax: number | null;
  actionPct: string;
  mdDays: string;
  mdPct: string;
}

export function automationFormError(f: AutomationFormValues): string | null {
  if (!f.name.trim()) return "Give the rule a name.";
  if (f.triggerType === "markdown_schedule") {
    if (wholeIn(f.mdDays, 1, 3650) == null) return "Enter how many days listed, 1 or more.";
    const { min, max } = AUTOMATION_BOUNDS.markdownPct;
    if (wholeIn(f.mdPct, min, max) == null) return `Markdown must be ${min} to ${max}% off.`;
    return null;
  }
  if (SELF_ACTING_TRIGGERS.has(f.triggerType)) return null;
  if (f.triggerNeedsDays && wholeIn(f.triggerDays, 1, 3650) == null) {
    return "Enter a number of days, 1 or more.";
  }
  if (wholeIn(f.cooldownDays, 1, 365) == null) {
    return "Enter how often it may re-apply, 1 day or more.";
  }
  if (f.actionPctMax != null) {
    const range = f.actionType === "price_drop_pct"
      ? AUTOMATION_BOUNDS.priceDropPct
      : f.actionType === "create_coded_coupon"
      ? AUTOMATION_BOUNDS.couponPct
      : f.actionType === "set_promo_rate_pct"
      ? AUTOMATION_BOUNDS.promoRatePct
      : f.actionType === "send_offer_to_watchers"
      ? { min: MIN_WATCHER_OFFER_PCT, max: MAX_WATCHER_OFFER_PCT }
      : { min: 1, max: f.actionPctMax };
    if (numberIn(f.actionPct, range.min, range.max) == null) {
      return `Enter a percent from ${range.min} to ${range.max}.`;
    }
  }
  return null;
}

export interface RepriceRuleFormValues {
  name: string;
  dropPct: string;
  intervalDays: string;
  minAgeDays: string;
}

export function repriceRuleFormError(f: RepriceRuleFormValues): string | null {
  if (!f.name.trim()) return "Give the rule a name.";
  const { dropPct, intervalDays, minAgeDays } = REPRICE_RULE_BOUNDS;
  if (numberIn(f.dropPct, dropPct.min, dropPct.max) == null) {
    return `Drop % must be ${dropPct.min} to ${dropPct.max}.`;
  }
  if (wholeIn(f.intervalDays, intervalDays.min, intervalDays.max) == null) {
    return `Every N days must be ${intervalDays.min} to ${intervalDays.max}.`;
  }
  if (f.minAgeDays.trim() && wholeIn(f.minAgeDays, minAgeDays.min, minAgeDays.max) == null) {
    return `Older than must be ${minAgeDays.min} to ${minAgeDays.max} days.`;
  }
  return null;
}
