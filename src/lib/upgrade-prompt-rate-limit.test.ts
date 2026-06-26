import { describe, it, expect } from "vitest";
import {
  upgradePromptKey,
  isUpgradePromptRateLimited,
  recordUpgradePromptShown,
  UPGRADE_PROMPT_COOLDOWN_MS,
  type PromptRateStore,
} from "./upgrade-prompt-rate-limit";
import type { UpgradeReason } from "@/stores/upgrade-dialog-store";

function memStore(): PromptRateStore {
  const m: Record<string, string> = {};
  return {
    get: (k) => m[k] ?? null,
    set: (k, v) => {
      m[k] = v;
    },
  };
}

const capReason: UpgradeReason = { type: "cap", kind: "includedGrades" };
const featureReason: UpgradeReason = { type: "feature", feature: "autolister" };

describe("upgradePromptKey", () => {
  it("distinguishes cap kind, feature, and user scope", () => {
    expect(upgradePromptKey(capReason, "u1")).not.toBe(
      upgradePromptKey({ type: "cap", kind: "activeListings" }, "u1"),
    );
    expect(upgradePromptKey(capReason, "u1")).not.toBe(
      upgradePromptKey(featureReason, "u1"),
    );
    expect(upgradePromptKey(capReason, "u1")).not.toBe(
      upgradePromptKey(capReason, "u2"),
    );
  });

  it("is stable for the same subject + scope", () => {
    expect(upgradePromptKey(capReason, "u1")).toBe(
      upgradePromptKey(capReason, "u1"),
    );
  });

  it("falls back to an anon scope when none is given", () => {
    expect(upgradePromptKey(capReason)).toContain("anon");
  });
});

describe("isUpgradePromptRateLimited / recordUpgradePromptShown", () => {
  it("is not rate-limited before the prompt has ever been shown", () => {
    const store = memStore();
    const key = upgradePromptKey(capReason, "u1");
    expect(isUpgradePromptRateLimited(key, 1_000, UPGRADE_PROMPT_COOLDOWN_MS, store)).toBe(
      false,
    );
  });

  it("is rate-limited immediately after being shown", () => {
    const store = memStore();
    const key = upgradePromptKey(capReason, "u1");
    recordUpgradePromptShown(key, 1_000, store);
    expect(isUpgradePromptRateLimited(key, 1_500, UPGRADE_PROMPT_COOLDOWN_MS, store)).toBe(
      true,
    );
  });

  it("is no longer rate-limited once the cooldown window has elapsed", () => {
    const store = memStore();
    const key = upgradePromptKey(capReason, "u1");
    recordUpgradePromptShown(key, 1_000, store);
    const later = 1_000 + UPGRADE_PROMPT_COOLDOWN_MS + 1;
    expect(isUpgradePromptRateLimited(key, later, UPGRADE_PROMPT_COOLDOWN_MS, store)).toBe(
      false,
    );
  });

  it("rate-limits each subject independently", () => {
    const store = memStore();
    const capKey = upgradePromptKey(capReason, "u1");
    const featureKey = upgradePromptKey(featureReason, "u1");
    recordUpgradePromptShown(capKey, 1_000, store);
    expect(isUpgradePromptRateLimited(capKey, 1_500, UPGRADE_PROMPT_COOLDOWN_MS, store)).toBe(
      true,
    );
    expect(
      isUpgradePromptRateLimited(featureKey, 1_500, UPGRADE_PROMPT_COOLDOWN_MS, store),
    ).toBe(false);
  });

  it("treats a corrupt stored value as not rate-limited", () => {
    const store = memStore();
    const key = upgradePromptKey(capReason, "u1");
    store.set(key, "not-a-number");
    expect(isUpgradePromptRateLimited(key, 1_000, UPGRADE_PROMPT_COOLDOWN_MS, store)).toBe(
      false,
    );
  });
});
