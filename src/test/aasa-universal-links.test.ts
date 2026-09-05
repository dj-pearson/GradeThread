import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// US-3108: Universal Links break silently, and they break across four files
// that no compiler reads together.
//
// The chain a password-reset email travels is: Apple fetches the AASA served by
// `functions/.well-known/apple-app-site-association.ts`, matches its appID
// against the installed app's team+bundle id, matches the tapped path against
// that file's `components`, and hands the URL to the app, which only accepts it
// if `AuthStore.isAuthCallback` agrees on the host and path, and only receives
// it at all if `GradeThread.entitlements` claims the domain. A disagreement
// anywhere sends the seller to Safari, signed out, with nothing logged.
//
// Nothing catches that today. The entitlements and the Swift are macOS-only, the
// Pages Function is TypeScript, and `ios/Scripts/check-aasa.sh` is a network
// probe. So this test reads all four as TEXT and asserts they describe the same
// thing.
//
// The failure that prompted it is instructive and is pinned below: check-aasa.sh
// carried a hard-coded team id, `RV6W9F4Y4P`, that appeared nowhere else in the
// repo and did not match production. The guard reported the live file as broken
// for as long as anyone ran it. Neither the app (ios/project.yml takes
// DEVELOPMENT_TEAM from $APPLE_TEAM_ID) nor the AASA (the Pages env var of the
// same name) hard-codes a team id, so a third copy could only ever go stale.

const root = (p: string) => resolve(__dirname, "../..", p);

const AASA_FN = readFileSync(
  root("functions/.well-known/apple-app-site-association.ts"),
  "utf8",
);
const ENTITLEMENTS = readFileSync(
  root("ios/GradeThread/GradeThread.entitlements"),
  "utf8",
);
const PROJECT_YML = readFileSync(root("ios/project.yml"), "utf8");
const CHECK_SH = readFileSync(root("ios/Scripts/check-aasa.sh"), "utf8");
const AUTH_STORE = readFileSync(
  root("ios/GradeThread/Auth/AuthStore.swift"),
  "utf8",
);

/** The bundle id the AASA function falls back to when IOS_BUNDLE_ID is unset. */
function aasaDefaultBundleId(): string {
  const m = /const DEFAULT_BUNDLE_ID = "([^"]+)"/.exec(AASA_FN);
  if (!m?.[1]) throw new Error("DEFAULT_BUNDLE_ID not found in the AASA function");
  return m[1];
}

/** Every path pattern the AASA claims, e.g. "/app/auth-callback*". */
function aasaClaimedPaths(): string[] {
  const block = /const APP_LINK_COMPONENTS = \[([\s\S]*?)\];/.exec(AASA_FN);
  if (!block?.[1]) throw new Error("APP_LINK_COMPONENTS not found");
  const paths = [...block[1].matchAll(/"\/":\s*"([^"]+)"/g)].map((m) => m[1]!);
  if (paths.length === 0) throw new Error("APP_LINK_COMPONENTS parsed empty");
  return paths;
}

/** The domains the entitlements claim, by prefix ("applinks" | "webcredentials"). */
function entitlementDomains(prefix: string): string[] {
  return [...ENTITLEMENTS.matchAll(/<string>([^<]+)<\/string>/g)]
    .map((m) => m[1]!)
    .filter((s) => s.startsWith(`${prefix}:`))
    .map((s) => s.slice(prefix.length + 1));
}

/** The app target's shipping bundle id, first PRODUCT_BUNDLE_IDENTIFIER in project.yml. */
function appBundleId(): string {
  const m = /PRODUCT_BUNDLE_IDENTIFIER:\s*(\S+)/.exec(PROJECT_YML);
  if (!m?.[1]) throw new Error("PRODUCT_BUNDLE_IDENTIFIER not found in project.yml");
  return m[1];
}

/** A claimed pattern like "/app/auth-callback*" matches a concrete path. */
function claims(pattern: string, path: string): boolean {
  return pattern.endsWith("*")
    ? path.startsWith(pattern.slice(0, -1))
    : pattern === path;
}

describe("US-3108: the AASA, the entitlements and the app agree", () => {
  it("the AASA's bundle id is the app target's bundle id", () => {
    expect(aasaDefaultBundleId()).toBe(appBundleId());
  });

  it("the app claims the domain the AASA is served from", () => {
    const url = /^URL="\$\{AASA_URL:-(\S+?)\}"/m.exec(CHECK_SH)?.[1];
    expect(url, "check-aasa.sh must probe a default URL").toBeTruthy();
    const host = new URL(url!).hostname;
    expect(entitlementDomains("applinks")).toContain(host);
    // webcredentials rides the same domain: the AASA advertises both, so the
    // entitlements have to claim both or password autofill silently stops.
    expect(entitlementDomains("webcredentials")).toContain(host);
    expect(AASA_FN).toContain("webcredentials");
  });

  it("the path AuthStore accepts is a path the AASA claims", () => {
    // The Swift guard is the last gate: a URL Apple hands over that AuthStore
    // rejects is a dead link with no log line.
    const swiftPath = /url\.path\.hasPrefix\("([^"]+)"\)/.exec(AUTH_STORE)?.[1];
    expect(swiftPath, "AuthStore.isAuthCallback path prefix not found").toBeTruthy();
    expect(
      aasaClaimedPaths().some((p) => claims(p, swiftPath!)),
      `AASA claims ${aasaClaimedPaths().join(", ")}, AuthStore accepts ${swiftPath}`,
    ).toBe(true);

    const swiftHost = /host == "([^"]+)"/.exec(AUTH_STORE)?.[1];
    expect(entitlementDomains("applinks")).toContain(swiftHost);
  });

  it("the path check-aasa.sh warns about is a path the AASA claims", () => {
    const expected = /^EXPECTED_PATH="([^"]+)"/m.exec(CHECK_SH)?.[1];
    expect(expected).toBeTruthy();
    expect(aasaClaimedPaths().some((p) => claims(p, expected!))).toBe(true);
  });

  it("check-aasa.sh hard-codes no team id", () => {
    // The US-3108 regression itself. A team id is 10 uppercase alphanumerics;
    // the only legitimate sources are $APPLE_TEAM_ID and an explicit argument.
    const literals = [...CHECK_SH.matchAll(/\b([A-Z0-9]{10})\.com\.gradethread/g)]
      .map((m) => m[1]!)
      // The comment block deliberately records both ids to explain the failure,
      // so only lines that could actually set a value count.
      .filter((id) =>
        CHECK_SH.split("\n").some(
          (line) => line.includes(id) && !line.trimStart().startsWith("#"),
        ),
      );
    expect(
      literals,
      "derive the team id from $APPLE_TEAM_ID; a third copy can only go stale",
    ).toEqual([]);
    expect(CHECK_SH).toContain("APPLE_TEAM_ID");
  });

  it("the AASA function fails closed on an unconfigured deploy", () => {
    // Both halves of the appID must fail closed. The team id already did; the
    // bundle id did not until US-2620, and served "<TEAMID>." with HTTP 200.
    expect(AASA_FN).toContain("(env.IOS_BUNDLE_ID ?? \"\").trim() || DEFAULT_BUNDLE_ID");
    expect(AASA_FN).toMatch(/status:\s*503/);
  });
});
