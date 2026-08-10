// US-1915 AC3: the per-mechanic kill-switch.
//
// US-1858 gave the reward system ONE switch — `rewards_tangible` — and it is a
// money switch: it stops payouts, all of them, at once. That is the right shape
// for an incident and the wrong shape for the question this story exists to
// answer. "Which mechanic is worth keeping?" needs the ability to turn ONE
// mechanic off and watch the north-star numbers, without stopping the other
// eight and without a deploy.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A SETTING AND NOT NINE FEATURE FLAGS.
//
// `FeatureKey` is a closed union in feature-flags.ts, so a flag per mechanic
// means editing that union — a deploy — every time a mechanic is added. The
// mechanics are already enumerated by `RewardEventType`, and the thing being
// configured is "which of those are off", which is one list. So this is a single
// system_settings key holding an array. A key never written returns the
// fallback, so this needs NO migration and no seed row: the empty list means
// everything is on, which is the state the system is in today.
//
// The money switch stays where it is. Disabling a mechanic here stops its EVENT
// from being written; `rewards_tangible` still independently governs whether any
// tangible payout happens at all. Those are different questions and collapsing
// them would mean an experiment on badges could stop grade credits.
// ─────────────────────────────────────────────────────────────────────────────

import { getSetting } from "./system-settings.ts";

/** The system_settings key. Never written by a migration — absent means "all on". */
export const DISABLED_MECHANICS_KEY = "rewards.disabled_mechanics";

/**
 * Which mechanics are currently switched off.
 *
 * ⚠ FAILS OPEN, and that is a deliberate inversion of `rewards_tangible`.
 *
 * That flag is read fail-CLOSED because failing open would pay out real money
 * during an outage. This one is read fail-OPEN because the failure mode is the
 * mirror image: a settings read that hiccups would otherwise silently freeze
 * every reward mechanic at once — turning a 30-second blip into an invisible
 * outage of the entire progression system, with no error anywhere, while the
 * money switch it is NOT was working fine. An unreadable list means "nothing is
 * disabled", which is the state that has always been true.
 */
export async function disabledMechanics(): Promise<Set<string>> {
  const raw = await getSetting<unknown>(DISABLED_MECHANICS_KEY, []);
  return normalizeDisabledMechanics(raw);
}

/**
 * Coerce whatever is in the setting into a set of mechanic names.
 *
 * Pure and exported so the parsing is testable without a database. The setting
 * is operator-editable jsonb with no schema behind it — a super-admin can put a
 * string, an object or a typo in there — so anything that is not a list of
 * non-empty strings has to degrade to "nothing disabled" rather than throw.
 * Throwing here would take down the grant primitive that every mechanic calls.
 */
export function normalizeDisabledMechanics(raw: unknown): Set<string> {
  if (!Array.isArray(raw)) return new Set();
  const out = new Set<string>();
  for (const v of raw) {
    if (typeof v === "string" && v.trim() !== "") out.add(v.trim());
  }
  return out;
}

/**
 * ⚠ RE-ENABLING DOES NOT BACKFILL, and it must not.
 *
 * While a mechanic is off, its reputation_events row is never written. The
 * reward state is recomputed FROM that log, so the XP was not merely hidden —
 * it never existed. Turning the mechanic back on resumes new grants and does
 * nothing about the gap.
 *
 * That is the correct behaviour: the alternative is a switch that quietly
 * accrues a debt and pays it out in a lump the moment someone flips it back,
 * which would spike every north-star number at exactly the point an operator is
 * trying to read the effect of turning it on. But it means the switch is an
 * EXPERIMENT CONTROL, not a pause button, and anyone using it on a mechanic that
 * pays tangible value is choosing to not pay it.
 */
export const RE_ENABLE_DOES_NOT_BACKFILL = true;
