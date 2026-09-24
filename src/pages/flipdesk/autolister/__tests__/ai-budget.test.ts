// AL-08: the client's "remaining" figure counts Action Credits exactly when
// the edge would spend them.
import { describe, expect, it } from "vitest";
import { aiActionBudget } from "../ai-budget";

describe("aiActionBudget (AL-08)", () => {
  it("5 actions left and 200 credits with no self-cap is 205", () => {
    expect(aiActionBudget({ planCap: 200, selfCap: null, used: 195, creditBalance: 200 })).toEqual({
      remaining: 205,
      allowance: 5,
      credits: 200,
    });
  });

  it("a self-cap below the plan never counts the wallet", () => {
    expect(aiActionBudget({ planCap: 200, selfCap: 50, used: 45, creditBalance: 200 })).toEqual({
      remaining: 5,
      allowance: 5,
      credits: 0,
    });
  });

  it("a self-cap of 0 is a stop, not a purchase", () => {
    expect(aiActionBudget({ planCap: 25, selfCap: 0, used: 0, creditBalance: 99 }).remaining).toBe(0);
  });

  it("a self-cap at or above the plan cannot bind, so credits count", () => {
    expect(aiActionBudget({ planCap: 200, selfCap: 500, used: 200, creditBalance: 7 }).remaining).toBe(7);
  });

  it("a missing wallet reads as zero and an over-used counter never goes negative", () => {
    expect(aiActionBudget({ planCap: 25, selfCap: null, used: 40, creditBalance: undefined })).toEqual({
      remaining: 0,
      allowance: 0,
      credits: 0,
    });
  });
});
