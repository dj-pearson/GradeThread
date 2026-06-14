// Unit tests for the AI cost budget guardrails core (US-895).
//
// decideBudgetActions/resolveFlagKey are pure; runBudgetGuardrails is fully
// dependency-injected, so the "simulated over-budget feature gets killed and the
// event is audited" path (AC5) is verifiable without a DB.
//
//   deno test src/tests/ai-budget_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  type BudgetStatus,
  decideBudgetActions,
  type RecordedBreach,
  resolveFlagKey,
  runBudgetGuardrails,
} from "../lib/ai-budget.ts";

function status(over: Partial<BudgetStatus> = {}): BudgetStatus {
  return {
    id: "b1",
    feature: "grading",
    period: "day",
    limitUsd: 10,
    action: "kill",
    enabled: true,
    spendUsd: 25,
    breached: true,
    pct: 250,
    updatedAt: "2026-06-14T00:00:00Z",
    ...over,
  };
}

Deno.test("resolveFlagKey maps known features and falls back to the feature name", () => {
  assertEquals(resolveFlagKey("content"), "content_ai");
  assertEquals(resolveFlagKey("grading"), "grading");
  assertEquals(resolveFlagKey("autolister"), "autolister");
  // Unmapped feature → itself (so a 1:1 flag still gets flipped).
  assertEquals(resolveFlagKey("reconcile"), "reconcile");
});

Deno.test("decideBudgetActions acts only on enabled, breached, not-already-open budgets", () => {
  const statuses: BudgetStatus[] = [
    status({ id: "kill1", action: "kill", breached: true }),
    status({ id: "alert1", action: "alert", breached: true }),
    status({ id: "notbreached", breached: false }),
    status({ id: "disabled", enabled: false }),
    status({ id: "alreadyopen", breached: true }),
  ];
  const planned = decideBudgetActions(statuses, new Set(["alreadyopen"]));

  const ids = planned.map((p) => p.status.id).sort();
  assertEquals(ids, ["alert1", "kill1"]);

  const kill = planned.find((p) => p.status.id === "kill1")!;
  assertEquals(kill.kill, true);
  assertEquals(kill.flagKey, "grading");

  const alertOnly = planned.find((p) => p.status.id === "alert1")!;
  assertEquals(alertOnly.kill, false);
  assertEquals(alertOnly.flagKey, null);
});

Deno.test("runBudgetGuardrails: a simulated over-budget feature gets killed and audited", async () => {
  const killed: string[] = [];
  const inserted: RecordedBreach[] = [];
  const audited: RecordedBreach[] = [];
  const alerted: RecordedBreach[] = [];

  const result = await runBudgetGuardrails({
    loadStatuses: () =>
      Promise.resolve([status({ id: "b1", feature: "grading", action: "kill" })]),
    loadOpenBreachBudgetIds: () => Promise.resolve(new Set<string>()),
    killFlag: (flagKey) => {
      killed.push(flagKey);
      return Promise.resolve(true);
    },
    alert: (b) => {
      alerted.push(b);
      return Promise.resolve(true);
    },
    insertBreach: (b) => {
      inserted.push(b);
      return Promise.resolve();
    },
    audit: (b) => {
      audited.push(b);
      return Promise.resolve();
    },
  });

  // The feature's kill-switch was flipped off.
  assertEquals(killed, ["grading"]);
  assertEquals(result.killed, 1);
  assertEquals(result.acted, 1);

  // The breach was recorded with killed=true …
  assertEquals(inserted.length, 1);
  assertEquals(inserted[0]!.killed, true);
  assertEquals(inserted[0]!.flagKey, "grading");

  // … an alert was emitted …
  assertEquals(alerted.length, 1);

  // … and the event was audited.
  assertEquals(audited.length, 1);
  assertEquals(audited[0]!.budgetId, "b1");
  assertEquals(audited[0]!.killed, true);
});

Deno.test("runBudgetGuardrails: an open breach suppresses re-action (no re-kill / re-alert)", async () => {
  let killCount = 0;
  let alertCount = 0;
  const result = await runBudgetGuardrails({
    loadStatuses: () => Promise.resolve([status({ id: "b1" })]),
    loadOpenBreachBudgetIds: () => Promise.resolve(new Set<string>(["b1"])),
    killFlag: () => {
      killCount++;
      return Promise.resolve(true);
    },
    alert: () => {
      alertCount++;
      return Promise.resolve(true);
    },
    insertBreach: () => Promise.resolve(),
    audit: () => Promise.resolve(),
  });

  assertEquals(result.acted, 0);
  assertEquals(killCount, 0);
  assertEquals(alertCount, 0);
});

Deno.test("runBudgetGuardrails: a feature still alerts when it has no killable flag is irrelevant for action=alert", async () => {
  const audited: RecordedBreach[] = [];
  let killCount = 0;
  const result = await runBudgetGuardrails({
    loadStatuses: () =>
      Promise.resolve([status({ id: "b2", feature: "reconcile", action: "alert" })]),
    loadOpenBreachBudgetIds: () => Promise.resolve(new Set<string>()),
    killFlag: () => {
      killCount++;
      return Promise.resolve(true);
    },
    alert: () => Promise.resolve(true),
    insertBreach: () => Promise.resolve(),
    audit: (b) => {
      audited.push(b);
      return Promise.resolve();
    },
  });

  // action=alert never kills.
  assertEquals(killCount, 0);
  assertEquals(result.killed, 0);
  assertEquals(result.acted, 1);
  assertEquals(audited[0]!.killed, false);
  assert(audited[0]!.flagKey === null);
});
