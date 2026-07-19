// US-2017: the three-way legal-version agreement (edge fallback / web / iOS).
//
// The edge derives the CURRENT legal versions dynamically from DB rows. Both
// clients hardcode them, and the only sync mechanism was a code comment in
// AuthStore.swift saying "Keep IN SYNC with the web ... and the edge mirror".
//
// A comment is not a mechanism — it is the same failure this codebase has hit
// repeatedly (a claim living somewhere nothing can execute). The consequence
// here is legally material rather than cosmetic: the moment an operator
// publishes a new ToS row, web and iOS signups keep recording 2026-04-01, so
// users are attested to a version they were never shown. Consent records are
// evidence, and a wrong-but-confident version string is worse than an absent
// one.
//
// This does NOT make the clients dynamic (US-2017 AC1's stronger option) — it
// makes divergence FAIL rather than pass silently, which is the property the
// comment was pretending to provide.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEGAL_VERSIONS } from "@/lib/constants";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const stripTs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** Pull a `static let <name> = "<value>"` out of the Swift source. */
function swiftLet(src: string, name: string): string | null {
  return src.match(new RegExp(`static let ${name}\\s*=\\s*"([^"]+)"`))?.[1] ?? null;
}

/** Pull an `export const <NAME> = "<value>"` out of the edge source. */
function tsConst(src: string, name: string): string | null {
  return stripTs(src).match(
    new RegExp(`export const ${name}\\s*=\\s*"([^"]+)"`),
  )?.[1] ?? null;
}

const swift = read("ios/GradeThread/Auth/AuthStore.swift");
const edge = read("services/edge-functions/src/lib/legal-versions.ts");

const iosTos = swiftLet(swift, "legalTosVersion");
const iosPrivacy = swiftLet(swift, "legalPrivacyVersion");
const edgeTos = tsConst(edge, "FALLBACK_TOS_VERSION");
const edgePrivacy = tsConst(edge, "FALLBACK_PRIVACY_VERSION");

describe("US-2017: legal versions agree across all three surfaces", () => {
  it("every source was actually parsed", () => {
    // Without this the comparisons below could pass vacuously by comparing
    // null to null — the exact way a guard ends up asserting nothing.
    expect(iosTos, "could not parse legalTosVersion from AuthStore.swift").toBeTruthy();
    expect(iosPrivacy, "could not parse legalPrivacyVersion from AuthStore.swift").toBeTruthy();
    expect(edgeTos, "could not parse FALLBACK_TOS_VERSION from legal-versions.ts").toBeTruthy();
    expect(edgePrivacy, "could not parse FALLBACK_PRIVACY_VERSION").toBeTruthy();
  });

  it("ToS version matches on web, iOS and the edge fallback", () => {
    expect(
      { web: LEGAL_VERSIONS.tos, ios: iosTos, edge: edgeTos },
      "A signup records the version the CLIENT believes is current. If these " +
        "diverge, users are attested to a document they were never shown — " +
        "update all three in the same commit, or make the clients read " +
        "/api/legal (US-2017 AC1).",
    ).toEqual({
      web: LEGAL_VERSIONS.tos,
      ios: LEGAL_VERSIONS.tos,
      edge: LEGAL_VERSIONS.tos,
    });
  });

  it("privacy version matches on web, iOS and the edge fallback", () => {
    expect({ web: LEGAL_VERSIONS.privacy, ios: iosPrivacy, edge: edgePrivacy }).toEqual({
      web: LEGAL_VERSIONS.privacy,
      ios: LEGAL_VERSIONS.privacy,
      edge: LEGAL_VERSIONS.privacy,
    });
  });

  it("versions are ISO dates, so they order correctly", () => {
    // The edge compares versions to decide whether re-acceptance is required;
    // a free-form string would break that ordering silently.
    for (const v of [LEGAL_VERSIONS.tos, LEGAL_VERSIONS.privacy, iosTos!, edgeTos!]) {
      expect(v, `"${v}" is not an ISO date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("US-2017: the iOS re-acceptance gap is recorded, not hidden", () => {
  it("iOS still does not call /api/legal — the gate is genuinely absent", () => {
    // Web has legal-gate.tsx; iOS has nothing. This test does NOT pretend that
    // is fixed. It asserts the gap still exists so the assertion FLIPS (and
    // this comment gets revisited) the moment someone implements AC2, rather
    // than the story quietly looking complete because the parity guard is green.
    // Comments are stripped first: AuthStore.swift's own header now DESCRIBES
    // the missing gate and names /api/legal, so a raw substring check would
    // match the documentation of the gap rather than the gap. That mistake has
    // recurred often enough this session to be the default assumption for any
    // "must not contain" assertion.
    const iosCode = read("ios/GradeThread/Auth/AuthStore.swift")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(iosCode).not.toContain("/api/legal");
    expect(
      read("src/components/auth/legal-gate.tsx"),
      "the web gate is the reference implementation for AC2",
    ).toContain("legal");
  });
});
