// US-3223. GradeThisItemCard has two writers of the validation block that sits
// beside the button charging for a grade: the tier effect and the inline
// garment picker's save. The effect got a guard on 2026-09-09; the save did
// not, and the interleaving below is what that left open.
import { describe, expect, it } from "vitest";

import { createRunOwner } from "@/lib/latest-run";
import { acceptValidation } from "@/components/flipdesk/grading-validation-run";
import type { ValidationItem, ValidationResult, GradingTier } from "@/hooks/use-grading";

function item(tier: GradingTier, cost: number): ValidationItem {
  return {
    inventory_item_id: "item-1",
    tier,
    cost,
    ready: true,
    blockers: [],
    title: "Carhartt Detroit jacket",
    garment_type: "jacket",
    garment_category: "outerwear",
    required_photo_types_missing: [],
  };
}

function result(
  tier: GradingTier,
  cost: number,
  user: Partial<ValidationResult["user"]> = {},
): ValidationResult {
  return {
    user: {
      plan: "pro",
      grades_used_this_month: 2,
      plan_limit: 50,
      grades_remaining: 48,
      ...user,
    },
    items: [item(tier, cost)],
    total_cost: cost,
    can_submit: true,
    limit_exceeded: false,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("acceptValidation", () => {
  it("returns the patch for the run that still owns the card", () => {
    const owner = createRunOwner();
    const patch = acceptValidation(
      owner.begin(),
      result("express", 24.99, {
        grades_remaining: 7,
        included_remaining: 3,
        credit_balance: 12,
      }),
    );

    expect(patch).not.toBeNull();
    expect(patch!.validation?.tier).toBe("express");
    expect(patch!.validation?.cost).toBe(24.99);
    expect(patch!.planRemaining).toBe(7);
    expect(patch!.includedRemaining).toBe(3);
    expect(patch!.creditBalance).toBe(12);
  });

  it("shows no count rather than Infinity on an unlimited plan", () => {
    const owner = createRunOwner();
    const patch = acceptValidation(
      owner.begin(),
      result("standard", 9.99, { grades_remaining: Number.POSITIVE_INFINITY }),
    );
    expect(patch!.planRemaining).toBeNull();
  });

  it("leaves the precedence inputs null when an older edge omits them", () => {
    const owner = createRunOwner();
    const patch = acceptValidation(owner.begin(), result("standard", 9.99));
    expect(patch!.includedRemaining).toBeNull();
    expect(patch!.creditBalance).toBeNull();
  });

  it("refuses a response whose run was superseded", () => {
    const owner = createRunOwner();
    const stale = owner.begin();
    owner.begin();
    expect(acceptValidation(stale, result("standard", 9.99))).toBeNull();
  });
});

describe("saveGarment racing the tier effect", () => {
  // The seller saves the garment picker on the standard tier, then flips the
  // picker to express while the save's re-validate is still out. Express
  // answers first and paints $24.99. Then the save's own standard response
  // lands and, before this guard, put $9.99 back under a picker reading
  // "express" -- and Submit charges express.
  it("keeps the tier the seller is looking at when the older save lands last", async () => {
    const owner = createRunOwner();
    const save = deferred<ValidationResult>();
    const tierFlip = deferred<ValidationResult>();

    const shown: Array<{ tier?: string; cost?: number }> = [];

    const saveRun = owner.begin();
    const savePending = save.promise.then((res) => {
      const patch = acceptValidation(saveRun, res);
      if (patch) shown.push({ tier: patch.validation?.tier, cost: patch.validation?.cost });
    });

    const effectRun = owner.begin();
    const effectPending = tierFlip.promise.then((res) => {
      const patch = acceptValidation(effectRun, res);
      if (patch) shown.push({ tier: patch.validation?.tier, cost: patch.validation?.cost });
    });

    tierFlip.resolve(result("express", 24.99));
    await effectPending;
    save.resolve(result("standard", 9.99));
    await savePending;

    expect(shown).toEqual([{ tier: "express", cost: 24.99 }]);
  });

  // And the other direction, which is the case saveGarment exists for: nothing
  // else started, so the save's own answer must land.
  it("applies the save's re-validate when nothing superseded it", async () => {
    const owner = createRunOwner();
    const save = deferred<ValidationResult>();
    let shown: ValidationItem | null = null;

    const run = owner.begin();
    const pending = save.promise.then((res) => {
      const patch = acceptValidation(run, res);
      if (patch) shown = patch.validation;
    });

    save.resolve(result("standard", 9.99));
    await pending;

    expect(shown).not.toBeNull();
    expect(shown!.tier).toBe("standard");
  });
});
