import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The Google Ads conversion tag is the one signal that tells a paid campaign
// whether it bought anything. GA4 is a separate product and `track()` reports to
// PostHog only, so neither can stand in for it. These guard the properties that
// matter: it fires when configured, it configures the account first, and it is
// inert when unconfigured — the site ships this before the conversion action
// exists in the Ads account.
//
// Each test imports the module fresh. `didConfigure` is module state by design
// (the account must be configured once per page, not once per signup), so a
// shared import would let one test's config satisfy the next test's assertion.
// Resetting modules keeps that state honest without putting a reset hook into
// production code.
async function freshModule() {
  vi.resetModules();
  return await import("./ads-conversion");
}

describe("Google Ads signup conversion", () => {
  beforeEach(() => {
    (window as unknown as { gtag?: (...a: unknown[]) => void }).gtag = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function gtagCalls(): unknown[][] {
    return (window.gtag as unknown as { mock: { calls: unknown[][] } }).mock
      .calls;
  }

  it("sends the conversion to the configured account and label", async () => {
    vi.stubEnv("VITE_GOOGLE_ADS_ID", "AW-123456789");
    vi.stubEnv("VITE_GOOGLE_ADS_SIGNUP_LABEL", "abcDEF123");
    const { reportSignupConversion } = await freshModule();

    reportSignupConversion("signup");

    expect(window.gtag).toHaveBeenCalledWith("event", "conversion", {
      send_to: "AW-123456789/abcDEF123",
    });
  });

  // A `send_to` naming an account gtag has never been configured with is dropped
  // silently — the exact failure this module exists to prevent, so the config
  // has to happen and it has to happen before the event.
  it("configures the Ads account before the first conversion, once only", async () => {
    vi.stubEnv("VITE_GOOGLE_ADS_ID", "AW-123456789");
    vi.stubEnv("VITE_GOOGLE_ADS_SIGNUP_LABEL", "abcDEF123");
    const { reportSignupConversion } = await freshModule();

    reportSignupConversion("signup");
    reportSignupConversion("signup");

    const calls = gtagCalls();
    const configs = calls.filter((c) => c[0] === "config");
    expect(configs).toEqual([["config", "AW-123456789"]]);
    expect(calls.findIndex((c) => c[0] === "config")).toBeLessThan(
      calls.findIndex((c) => c[0] === "event"),
    );
    // Both signups are still reported; only the config is deduped.
    expect(calls.filter((c) => c[0] === "event")).toHaveLength(2);
  });

  // auth-confirm.tsx handles every Supabase email confirmation, not just
  // signups: `recovery` is a password reset and `email_change` and `magiclink`
  // are existing users. Reporting those as signups would inflate the conversion
  // count with people who were already customers — and a paid campaign judged on
  // an inflated number is worse than one judged on no number, because it looks
  // like it is working.
  it("reports a new-account confirmation", async () => {
    vi.stubEnv("VITE_GOOGLE_ADS_ID", "AW-123456789");
    vi.stubEnv("VITE_GOOGLE_ADS_SIGNUP_LABEL", "abcDEF123");
    const { reportSignupConversion } = await freshModule();

    for (const type of ["signup", "email", null]) {
      reportSignupConversion(type);
    }

    expect(gtagCalls().filter((c) => c[0] === "event")).toHaveLength(3);
  });

  it("does not report a recovery, email change or magic link as a signup", async () => {
    vi.stubEnv("VITE_GOOGLE_ADS_ID", "AW-123456789");
    vi.stubEnv("VITE_GOOGLE_ADS_SIGNUP_LABEL", "abcDEF123");
    const { reportSignupConversion } = await freshModule();

    for (const type of ["recovery", "email_change", "magiclink", "invite"]) {
      reportSignupConversion(type);
    }

    expect(gtagCalls().filter((c) => c[0] === "event")).toHaveLength(0);
  });

  it("does nothing when the account id is unset, so shipping it early is safe", async () => {
    vi.stubEnv("VITE_GOOGLE_ADS_ID", "");
    vi.stubEnv("VITE_GOOGLE_ADS_SIGNUP_LABEL", "abcDEF123");
    const { reportSignupConversion } = await freshModule();

    reportSignupConversion("signup");

    expect(window.gtag).not.toHaveBeenCalled();
  });

  it("does nothing when the label is unset", async () => {
    vi.stubEnv("VITE_GOOGLE_ADS_ID", "AW-123456789");
    vi.stubEnv("VITE_GOOGLE_ADS_SIGNUP_LABEL", "");
    const { reportSignupConversion } = await freshModule();

    reportSignupConversion("signup");

    expect(window.gtag).not.toHaveBeenCalled();
  });

  it("never throws when gtag is absent (blocked, or before the loader runs)", async () => {
    vi.stubEnv("VITE_GOOGLE_ADS_ID", "AW-123456789");
    vi.stubEnv("VITE_GOOGLE_ADS_SIGNUP_LABEL", "abcDEF123");
    const { reportSignupConversion } = await freshModule();
    delete (window as unknown as { gtag?: unknown }).gtag;

    expect(() => reportSignupConversion("signup")).not.toThrow();
  });
});
