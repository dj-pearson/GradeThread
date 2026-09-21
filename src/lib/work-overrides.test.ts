// US-3182: what a seller may correct, and what a correction may never do.
//
// The two rules worth stating up front, because they are the ones a plausible
// implementation gets wrong: a snooze must NEVER hide a shipping obligation
// that has become urgent, and an override must never become training data for
// the duration learner.

import { describe, it, expect } from "vitest";
import {
  MAX_OVERRIDE_CENTS,
  MAX_OVERRIDE_MINUTES,
  OVERRIDE_KINDS,
  SNOOZE_DAYS,
  SUPPRESSION_KINDS,
  decideMinutes,
  differenceFromOverride,
  isSuppressed,
  isTrainingData,
  snoozeUntil,
  validateOverride,
  type StoredOverride,
  type StoredSuppression,
} from "@/lib/work-overrides";

const NOW = "2026-09-21T12:00:00.000Z";

function daysFromNow(n: number): string {
  return new Date(Date.parse(NOW) + n * 86_400_000).toISOString();
}

function suppression(over: Partial<StoredSuppression> = {}): StoredSuppression {
  return {
    inventoryItemId: "item-1",
    actionKey: null,
    kind: "snooze",
    sessionId: null,
    until: daysFromNow(3),
    createdAt: NOW,
    ...over,
  };
}

describe("validation collects every error (AC1)", () => {
  it("accepts a sensible duration", () => {
    const r = validateOverride("task_minutes", { amount: 20 });
    expect(r.ok).toBe(true);
  });

  it("refuses a duration of zero, but accepts a cost of zero", () => {
    // "This takes no time" is not a real statement and would sort the task to
    // the front of every plan forever. "This costs me nothing more" is.
    expect(validateOverride("task_minutes", { amount: 0 }).ok).toBe(false);
    expect(validateOverride("remaining_cost", { amount: 0 }).ok).toBe(true);
  });

  it("refuses negative, nonfinite and non-numeric values", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "20", null, undefined]) {
      const r = validateOverride("task_minutes", { amount: bad as number });
      expect(r.ok, `${String(bad)} should be refused`).toBe(false);
    }
  });

  it("refuses a duration longer than a whole session, rather than clamping", () => {
    const r = validateOverride("task_minutes", { amount: MAX_OVERRIDE_MINUTES + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain("above_minutes_bound");
    // A clamped 6000 becomes a plausible 240 and the seller never learns
    // their number was thrown away.
    expect(MAX_OVERRIDE_MINUTES).toBe(240);
  });

  it("refuses a value that is almost certainly dollars typed as cents", () => {
    const r = validateOverride("value_range", {
      lowCents: 0,
      highCents: MAX_OVERRIDE_CENTS + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain("above_value_bound");
  });

  it("refuses an inverted range rather than silently swapping it", () => {
    const r = validateOverride("value_range", { lowCents: 900, highCents: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toContain("range_inverted");
  });

  it("reports BOTH bad numbers, not just the first", () => {
    const r = validateOverride("value_range", { lowCents: -1, highCents: -2 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.filter((e) => e === "negative")).toHaveLength(2);
  });

  it("refuses a kind it does not know", () => {
    const r = validateOverride("repaint_it", { amount: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual(["unknown_kind"]);
  });
});

describe("a snooze NEVER hides a deadline (AC3)", () => {
  it("an urgent shipping obligation beats every suppression", () => {
    // THE MOST IMPORTANT ASSERTION IN THIS FILE. A buyer has paid and the
    // clock is the marketplace's. A seller who snoozed last week did not
    // agree to miss a ship-by date this week.
    for (const kind of SUPPRESSION_KINDS) {
      const v = isSuppressed(
        [suppression({
          kind,
          until: kind === "snooze" ? daysFromNow(6) : null,
          sessionId: kind === "skip_session" ? "s1" : null,
        })],
        { now: NOW, sessionId: "s1", urgentShipping: true },
      );
      expect(v.suppressed, `${kind} hid an urgent shipment`).toBe(false);
      expect(v.reason).toBe("urgent_shipping_overrides_suppression");
    }
  });

  it("and it still suppresses when the shipment is not urgent", () => {
    const v = isSuppressed([suppression()], { now: NOW, urgentShipping: false });
    expect(v.suppressed).toBe(true);
  });
});

describe("snooze expiry, on a fixed clock (AC3, AC6)", () => {
  it("suppresses before the expiry", () => {
    const v = isSuppressed([suppression({ until: daysFromNow(3) })], { now: NOW });
    expect(v).toEqual({ suppressed: true, reason: "snooze" });
  });

  it("stops at the expiry, and says it expired rather than saying nothing", () => {
    const v = isSuppressed([suppression({ until: daysFromNow(-1) })], { now: NOW });
    expect(v.suppressed).toBe(false);
    expect(v.reason).toBe("snooze_expired");
  });

  it("the boundary itself is no longer suppressed", () => {
    const v = isSuppressed([suppression({ until: NOW })], { now: NOW });
    expect(v.suppressed).toBe(false);
  });

  it("a snooze with no end does NOT suppress", () => {
    // A snooze that never expires is a dismissal nobody asked for. The
    // database refuses the row too (00820's shape check); this is the half
    // that holds if one ever arrives from somewhere else.
    expect(isSuppressed([suppression({ until: null })], { now: NOW }).suppressed)
      .toBe(false);
    expect(isSuppressed([suppression({ until: "not a date" })], { now: NOW }).suppressed)
      .toBe(false);
  });

  it("snoozeUntil is seven days and the constant says so", () => {
    expect(SNOOZE_DAYS).toBe(7);
    expect(snoozeUntil(NOW)).toBe(daysFromNow(7));
  });

  it("snoozeUntil refuses a time it cannot read", () => {
    expect(() => snoozeUntil("whenever")).toThrow();
  });
});

describe("skip applies to ONE session (AC3)", () => {
  it("suppresses in the session it was skipped in", () => {
    const v = isSuppressed(
      [suppression({ kind: "skip_session", sessionId: "s1", until: null })],
      { now: NOW, sessionId: "s1" },
    );
    expect(v).toEqual({ suppressed: true, reason: "skip_session" });
  });

  it("and NOT in the next one", () => {
    // Carrying a skip into tomorrow's plan would silently turn it into a
    // dismissal, which is not what the seller pressed.
    const v = isSuppressed(
      [suppression({ kind: "skip_session", sessionId: "s1", until: null })],
      { now: NOW, sessionId: "s2" },
    );
    expect(v.suppressed).toBe(false);
  });

  it("nor when there is no session at all", () => {
    const v = isSuppressed(
      [suppression({ kind: "skip_session", sessionId: "s1", until: null })],
      { now: NOW },
    );
    expect(v.suppressed).toBe(false);
  });
});

describe("dismiss lasts until reset (AC3)", () => {
  it("has no clock, and suppresses regardless of session", () => {
    const rows = [suppression({ kind: "dismiss", until: null, sessionId: null })];
    for (const ctx of [{ now: NOW }, { now: daysFromNow(400), sessionId: "s9" }]) {
      expect(isSuppressed(rows, ctx)).toEqual({ suppressed: true, reason: "dismiss" });
    }
  });

  it("nothing here marks anything sold, archived or deleted", () => {
    const src = codeOf("src/lib/work-overrides.ts");
    for (const banned of ["archive", "sold", "delete", "supabase", "fetch("]) {
      expect(src, `work-overrides.ts contains "${banned}"`).not.toContain(banned);
    }
    expect(src).toContain("export function isSuppressed");
  });
});

describe("precedence: override, then learned, then default (AC4)", () => {
  it("an override beats the seller's own learned history", () => {
    // It should: the learned median is what they USUALLY take, and the
    // override is what they are telling us about THIS garment.
    const d = decideMinutes({ overrideMinutes: 20, learnedMinutes: 4, defaultMinutes: 8 });
    expect(d).toEqual({ minutes: 20, source: "override", withoutOverride: 4 });
  });

  it("learned beats the default", () => {
    const d = decideMinutes({ overrideMinutes: null, learnedMinutes: 4, defaultMinutes: 8 });
    expect(d).toEqual({ minutes: 4, source: "learned", withoutOverride: null });
  });

  it("the default answers when there is nothing else", () => {
    const d = decideMinutes({ overrideMinutes: null, learnedMinutes: null, defaultMinutes: 8 });
    expect(d).toEqual({ minutes: 8, source: "default", withoutOverride: null });
  });

  it("clearing an override falls back to learned, not to default", () => {
    const d = decideMinutes({ overrideMinutes: null, learnedMinutes: 4, defaultMinutes: 8 });
    expect(d.source).toBe("learned");
  });

  it("withoutOverride reports what the plan WOULD have said", () => {
    // So the difference can be shown before an active plan is replaced,
    // rather than the seller having to remember.
    expect(decideMinutes({
      overrideMinutes: 30, learnedMinutes: null, defaultMinutes: 8,
    }).withoutOverride).toBe(8);
  });
});

describe("the difference is shown, not applied silently (AC2, AC4)", () => {
  it("reports before, after and whether it still fits", () => {
    const d = differenceFromOverride({
      key: "item-1:photograph",
      decision: decideMinutes({ overrideMinutes: 45, learnedMinutes: null, defaultMinutes: 8 }),
      remainingBudgetMinutes: 30,
    });
    expect(d).toEqual({
      key: "item-1:photograph",
      beforeMinutes: 8,
      afterMinutes: 45,
      nowDoesNotFit: true,
    });
  });

  it("a fitting change is not flagged", () => {
    const d = differenceFromOverride({
      key: "k",
      decision: decideMinutes({ overrideMinutes: 12, learnedMinutes: null, defaultMinutes: 8 }),
      remainingBudgetMinutes: 30,
    });
    expect(d.nowDoesNotFit).toBe(false);
  });

  it("not fitting is a FACT, not a refusal", () => {
    // The correction is still recorded; the seller is told what it costs.
    const d = differenceFromOverride({
      key: "k",
      decision: decideMinutes({ overrideMinutes: 200, learnedMinutes: null, defaultMinutes: 8 }),
      remainingBudgetMinutes: 30,
    });
    expect(d.afterMinutes).toBe(200);
  });
});

describe("an override is never training data (AC4)", () => {
  it("says no, for every kind", () => {
    // Without this a seller who overrides optimistically would train the
    // estimator to agree with them, and every estimate would drift toward
    // what they hoped rather than what happened.
    for (const kind of OVERRIDE_KINDS) {
      const o: StoredOverride = {
        inventoryItemId: "item-1",
        actionKey: null,
        kind,
        value: { amount: 5 },
        originalValue: null,
        source: "seller",
        updatedAt: NOW,
      };
      expect(isTrainingData(o)).toBe(false);
    }
  });

  it("and the learner does not import this module", () => {
    const learner = codeOf("src/lib/work-duration-learning.ts");
    expect(learner).not.toContain("work-overrides");
  });
});

function codeOf(rel: string): string {
  // Comments stripped as BLOCKS: the headers explain what these files must
  // not do, so a naive scan finds the banned word inside the sentence
  // forbidding it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path") as typeof import("node:path");
  return fs.readFileSync(path.resolve(process.cwd(), rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
}
