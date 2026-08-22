// US-2102: every anchor an unsubscribe / preference email points at must
// resolve to a real element.
//
// accountPreferenceCenterUrl() linked to /dashboard/account#email-preferences.
// Both halves were wrong: the preference UI lives on /dashboard/settings (the
// notifications tab), and no #email-preferences anchor existed anywhere in the
// frontend — zero matches across src/**/*.tsx. A user clicking "manage
// preferences" from an unsubscribe confirmation landed on the wrong page with
// no such section.
//
// That is real compliance exposure the moment lifecycle email is switched on:
// the opt-out route we advertise has to actually work, and nothing failed when
// it did not.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NOTIFICATION_TYPES } from "@/lib/notification-preferences";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const stripComments = (s: string) =>
  s.replace(/\r\n?/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const unsubscribe = read("services/edge-functions/src/lib/unsubscribe.ts");
const routes = read("src/routes/index.tsx");

/** Every in-app URL the email layer hands to a recipient. */
function emittedAppUrls(): string[] {
  const code = stripComments(unsubscribe);
  return [...code.matchAll(/\$\{SITE_URL\}(\/[^`"'\s]*)/g)].map((m) => m[1]!);
}

describe("US-2102: emitted preference anchors resolve", () => {
  it("emits at least one in-app preference URL", () => {
    // If the extraction breaks, the assertions below pass while checking
    // nothing — the failure mode this whole session keeps surfacing.
    expect(emittedAppUrls().length).toBeGreaterThan(0);
  });

  it("every emitted path is a REAL route", () => {
    for (const url of emittedAppUrls()) {
      const path = url.split("?")[0]!.split("#")[0]!;
      expect(
        routes,
        `email links to ${path}, which is not a registered route`,
      ).toContain(`path: "${path}"`);
    }
  });

  it("every emitted #fragment exists as an id in the frontend", () => {
    const settings = read("src/pages/settings.tsx");
    const account = read("src/pages/account.tsx");
    const haystack = settings + account;
    for (const url of emittedAppUrls()) {
      const frag = url.includes("#") ? url.split("#")[1] : null;
      if (!frag) continue;
      expect(
        haystack,
        `email links to #${frag}, but no element carries id="${frag}" — the ` +
          `advertised opt-out path dead-ends`,
      ).toContain(`id="${frag}"`);
    }
  });

  it("the preference link targets the page that actually has the controls", () => {
    // Regression guard for the specific mistake: /dashboard/account has no
    // preference UI at all; it lives on /dashboard/settings.
    const code = stripComments(unsubscribe);
    expect(code).toContain("/dashboard/settings");
    expect(code).not.toContain("/dashboard/account");
  });

  it("deep-links the notifications tab, not just the page", () => {
    // The settings page is tabbed; landing on the profile tab would still hide
    // the controls the email promised.
    expect(stripComments(unsubscribe)).toContain("tab=notifications");
  });
});

describe("US-2102: the marketing umbrella is user-controllable in-app", () => {
  it("the master marketing key is exposed in the settings UI", () => {
    // It gates EVERY marketing send path (US-911 MARKETING_MASTER_KEY) but was
    // surfaced nowhere, so a user could only opt out via an emailed link.
    const keys = NOTIFICATION_TYPES.map((c) => c.key);
    expect(keys).toContain("marketing");
  });

  it("it is described as an override, not a peer toggle", () => {
    const cat = NOTIFICATION_TYPES.find((c) => c.key === "marketing")!;
    expect(cat.channels).toContain("email");
    // The granular toggles gate additionally — off here means off regardless.
    expect(cat.description.toLowerCase()).toMatch(/whatever the settings below|regardless/);
    // And it must not imply transactional mail is affected, which would be a
    // false promise in the other direction.
    expect(cat.description.toLowerCase()).toContain("transactional");
  });

  it("it is listed before the granular marketing categories it overrides", () => {
    const keys = NOTIFICATION_TYPES.map((c) => c.key);
    expect(keys.indexOf("marketing")).toBeLessThan(keys.indexOf("weekly_newsletter"));
  });
});
