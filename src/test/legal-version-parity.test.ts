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
  s.replace(/\r\n?/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

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

describe("US-2017 AC2: iOS has a re-acceptance gate", () => {
  // FLIPPED 2026-08-12. This block used to assert the gap still EXISTED — iOS
  // calling nothing, so the story could not look complete while the parity
  // guard was green. The gate now exists, so the assertion has to invert or it
  // would fail on the fix. Kept in the same file because the two halves are one
  // rule: agreeing constants are worthless if nobody is ever re-asked.
  const strip = (s: string) =>
    s.replace(/\r\n?/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("calls the server for the decision rather than comparing versions locally", () => {
    const gate = strip(read("ios/GradeThread/Auth/LegalGate.swift"));
    expect(gate, "the gate no longer asks the server whether an acceptance is owed")
      .toContain("/api/legal/status");
    expect(gate, "the gate no longer records acceptance").toContain("/api/legal/accept");
    // The point of asking the server: an operator publishing a re-acceptance
    // must reach an INSTALLED build with no App Store release. A client that
    // compared its own hardcoded constant could not.
    expect(
      gate,
      "the gate compares version strings itself, so a new version would need " +
        "an App Store release to be enforced",
    ).not.toContain("legalTosVersion");
  });

  it("cannot be dismissed, and stays up when recording fails", () => {
    const gate = strip(read("ios/GradeThread/Auth/LegalGate.swift"));
    expect(
      gate,
      "the sheet is dismissable, so a seller can reach the app with nothing " +
        "recorded — which is the state the gate exists to prevent",
    ).toContain("interactiveDismissDisabled(true)");
    // needsAcceptance must NOT be cleared on the failure path.
    const acceptBody = gate.slice(gate.indexOf("public func accept()"));
    const clearIdx = acceptBody.indexOf("needsAcceptance = false");
    const catchIdx = acceptBody.indexOf("} catch {");
    expect(
      clearIdx >= 0 && clearIdx < catchIdx,
      "acceptance is cleared outside the success path, so a failed POST would " +
        "dismiss the gate having recorded nothing",
    ).toBe(true);
  });

  it("fails OPEN on a status read failure", () => {
    // A network blip is not evidence that the user has not accepted, and
    // locking a paying seller out of their inventory to protest an unreachable
    // endpoint is worse than showing the gate one launch later. Same reasoning
    // as the web gate.
    const gate = strip(read("ios/GradeThread/Auth/LegalGate.swift"));
    const refreshBody = gate.slice(
      gate.indexOf("public func refresh()"),
      gate.indexOf("public func accept()"),
    );
    expect(
      /catch\s*\{[^}]*needsAcceptance = false/.test(refreshBody),
      "refresh() does not fail open — a 500 would lock every iOS user out",
    ).toBe(true);
  });

  it("is mounted around the authenticated app, not merely defined", () => {
    // The failure this catches is the one the whole story is about: a gate that
    // exists in the repo and is never rendered is the same as no gate.
    expect(
      strip(read("ios/GradeThread/ContentView.swift")),
      "LegalGate is not mounted in ContentView, so it never runs",
    ).toContain("LegalGate");
  });
});
