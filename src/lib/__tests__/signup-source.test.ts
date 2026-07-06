// US-1670: the signup-source survey options must stay in sync with the whitelist
// in the handle_new_user() trigger (migration 00379) and the SignupSource union
// (src/types/database.ts). If they drift, a user's selection is silently dropped
// to NULL by the trigger. This pins the set so a change to one side fails CI.

import { describe, it, expect } from "vitest";
import { SIGNUP_SOURCE_OPTIONS } from "@/lib/constants";
import type { SignupSource } from "@/types/database";

// The exact whitelist the migration 00379 trigger accepts (keep in lockstep).
const TRIGGER_WHITELIST: readonly SignupSource[] = [
  "ai_assistant",
  "search",
  "social",
  "reddit",
  "youtube",
  "friend",
  "reseller_community",
  "ad",
  "other",
];

describe("signup-source survey (US-1670)", () => {
  it("every option value is accepted by the handle_new_user trigger whitelist", () => {
    const optionValues = SIGNUP_SOURCE_OPTIONS.map((o) => o.value);
    for (const v of optionValues) {
      expect(TRIGGER_WHITELIST).toContain(v);
    }
  });

  it("covers the full whitelist (no value is un-selectable)", () => {
    const optionValues = new Set(SIGNUP_SOURCE_OPTIONS.map((o) => o.value));
    for (const v of TRIGGER_WHITELIST) {
      expect(optionValues.has(v)).toBe(true);
    }
  });

  it("includes the AI-assistant option (the point of the survey)", () => {
    const ai = SIGNUP_SOURCE_OPTIONS.find((o) => o.value === "ai_assistant");
    expect(ai).toBeDefined();
    expect(ai?.label.toLowerCase()).toContain("ai assistant");
  });

  it("every option has a non-empty label and a unique value", () => {
    const values = SIGNUP_SOURCE_OPTIONS.map((o) => o.value);
    expect(new Set(values).size).toBe(values.length);
    for (const o of SIGNUP_SOURCE_OPTIONS) {
      expect(o.label.trim().length).toBeGreaterThan(0);
    }
  });
});
