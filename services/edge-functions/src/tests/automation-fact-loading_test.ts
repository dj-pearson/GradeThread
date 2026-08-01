// US-2156: the automation runner's "load only what the ruleset asks for" gates,
// and the dry-run effect line.
//
// The lazy loading matters for cost, not correctness: a seller whose rules are
// all aging-based must pay for ZERO extra queries — no marketplace-event read,
// no grade-report read, no sibling-platform read, no negotiation-capability
// read. These two pure predicates are what decides that, so they are tested
// directly rather than through a DB fake.
//
// describePlannedEffect matters for honesty: a dry run that lists a matched
// listing with no visible effect reads as a bug, because the price/promo
// columns say nothing about a crosslist, a notify or a status move.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import type {
  AutomationAction,
  AutomationTrigger,
} from "../lib/automation-rules.ts";
import {
  describePlannedEffect,
  maxTriggerWindowDays,
  usesAction,
} from "../routes/flipdesk-automations.ts";

const aging: AutomationTrigger = {
  type: "days_listed_gt",
  days: 30,
  cooldown_days: 7,
};
const drop: AutomationAction = {
  type: "price_drop_pct",
  pct: 10,
  margin_floor_pct: 10,
};

Deno.test("US-2156: an all-aging ruleset asks for none of the new facts", () => {
  const rules = [
    { trigger_json: aging, action_json: drop },
    {
      trigger_json: {
        type: "no_views_in_days",
        days: 14,
        cooldown_days: 7,
      } as AutomationTrigger,
      action_json: { type: "end_listing" } as AutomationAction,
    },
  ];
  assertEquals(maxTriggerWindowDays(rules, "offer_received"), 0);
  assertEquals(maxTriggerWindowDays(rules, "return_opened"), 0);
  assertEquals(maxTriggerWindowDays(rules, "grade_completed"), 0);
  assertEquals(usesAction(rules, "crosslist_to"), false);
  assertEquals(usesAction(rules, "send_offer_to_watchers"), false);
});

Deno.test("US-2156: the lookback is the WIDEST window any rule of that type needs", () => {
  // One query has to serve every rule, so a 7-day rule and a 30-day rule must
  // produce a 30-day read — not two reads, and not a 7-day one that starves the
  // wider rule.
  const rules = [
    {
      trigger_json: { type: "offer_received", days: 7, cooldown_days: 7 } as AutomationTrigger,
      action_json: drop,
    },
    {
      trigger_json: { type: "offer_received", days: 30, cooldown_days: 7 } as AutomationTrigger,
      action_json: drop,
    },
    {
      trigger_json: { type: "return_opened", days: 3, cooldown_days: 7 } as AutomationTrigger,
      action_json: drop,
    },
  ];
  assertEquals(maxTriggerWindowDays(rules, "offer_received"), 30);
  assertEquals(maxTriggerWindowDays(rules, "return_opened"), 3);
  // A type no rule uses still costs nothing.
  assertEquals(maxTriggerWindowDays(rules, "grade_completed"), 0);
});

Deno.test("US-2156: usesAction spots the two actions that need extra loads", () => {
  const rules = [
    { trigger_json: aging, action_json: drop },
    {
      trigger_json: aging,
      action_json: { type: "crosslist_to", platform: "etsy" } as AutomationAction,
    },
  ];
  assert(usesAction(rules, "crosslist_to"));
  assert(!usesAction(rules, "send_offer_to_watchers"));
  assert(usesAction(rules, "price_drop_pct"));
});

Deno.test("US-2156: describePlannedEffect covers every new action and stays quiet on the old ones", () => {
  assertEquals(
    describePlannedEffect({ kind: "relist" }),
    "End the listing and return the item to Drafts to relist",
  );
  assertEquals(
    describePlannedEffect({ kind: "crosslist", platform: "etsy" }),
    "Cross-list to etsy",
  );
  assertEquals(
    describePlannedEffect({ kind: "send_watcher_offer", discountPct: 10 }),
    "Offer watchers 10% off",
  );
  assertEquals(
    describePlannedEffect({ kind: "advance_status", status: "archived" }),
    "Move the item to archived",
  );
  assertEquals(
    describePlannedEffect({ kind: "notify", message: "Check this" }),
    "Notify: Check this",
  );
  // The price/promo/coupon/end actions already have their own columns in the
  // dry-run row, so a second line would just duplicate them.
  assertEquals(
    describePlannedEffect({ kind: "price_drop", newCents: 100, floored: false }),
    null,
  );
  assertEquals(describePlannedEffect({ kind: "set_promo_rate", newRatePct: 4 }), null);
  assertEquals(describePlannedEffect({ kind: "create_coupon", discountPct: 20 }), null);
  assertEquals(describePlannedEffect({ kind: "end_listing" }), null);
});
