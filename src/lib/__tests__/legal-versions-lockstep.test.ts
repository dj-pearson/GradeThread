// US-2017 / US-2019 — the legal-version baseline exists in THREE projects.
//
//   web   src/lib/constants.ts            LEGAL_VERSIONS
//   edge  lib/legal-versions.ts           FALLBACK_TOS_VERSION / FALLBACK_PRIVACY_VERSION
//   iOS   Auth/AuthStore.swift            legalTosVersion / legalPrivacyVersion
//
// None of the three could import the others, and nothing pinned them — the only
// mechanism was a comment ("Keep IN SYNC with the edge mirror").
//
// WHAT THIS IS AND IS NOT, stated precisely, because the finding that produced
// this test overstated the risk and the correction is worth keeping:
//
// The web does NOT blindly trust its constant at the gate. legal-gate.tsx asks
// /api/legal/status, and /api/legal/accept stamps the SERVER's current versions
// (legal.ts:103-106) — never a client-supplied value. So after a FORCING
// republish the system self-corrects: the gate fires and the audit row is
// written with the real version.
//
// The residual hole is narrower and does not self-correct. On a MINOR republish
// (requires_reacceptance: false) `requiredSince` deliberately does not advance,
// so the gate correctly stays quiet — but handle_new_user (00142:79) still
// records the CLIENT-SUPPLIED constant into users.tos_accepted_version. The new
// user was shown the current document (/terms serves the live one) while their
// record names an older version, and nothing later corrects it.
//
// That is why this guard exists: the constant drifting further is the thing that
// widens that window.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LEGAL_VERSIONS } from "@/lib/constants";

function readRepoFile(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

function extract(src: string, pattern: RegExp, label: string): string {
  const m = pattern.exec(src);
  if (!m?.[1]) {
    throw new Error(
      `Could not find ${label}. If it moved, UPDATE THIS GUARD rather than ` +
        `deleting it — it is the only thing keeping three projects' legal ` +
        `baselines aligned.`,
    );
  }
  return m[1];
}

describe("legal version baseline (3-project lockstep)", () => {
  const edgeSrc = readRepoFile("services/edge-functions/src/lib/legal-versions.ts");

  it("matches the EDGE fallback baseline", () => {
    const edgeTos = extract(
      edgeSrc,
      /FALLBACK_TOS_VERSION\s*=\s*"([^"]+)"/,
      "FALLBACK_TOS_VERSION",
    );
    const edgePrivacy = extract(
      edgeSrc,
      /FALLBACK_PRIVACY_VERSION\s*=\s*"([^"]+)"/,
      "FALLBACK_PRIVACY_VERSION",
    );
    expect(
      LEGAL_VERSIONS.tos,
      "web LEGAL_VERSIONS.tos drifted from the edge FALLBACK_TOS_VERSION",
    ).toBe(edgeTos);
    expect(
      LEGAL_VERSIONS.privacy,
      "web LEGAL_VERSIONS.privacy drifted from the edge FALLBACK_PRIVACY_VERSION",
    ).toBe(edgePrivacy);
  });

  it("matches the iOS baseline", () => {
    // iOS cannot be compiled on every dev machine (xcodebuild is macOS-only),
    // so a source-level assertion is the only cross-project check available —
    // and it is exactly the check that would have caught a one-sided edit.
    const swift = readRepoFile("ios/GradeThread/Auth/AuthStore.swift");
    const iosTos = extract(
      swift,
      /legalTosVersion\s*=\s*"([^"]+)"/,
      "AuthStore.legalTosVersion",
    );
    const iosPrivacy = extract(
      swift,
      /legalPrivacyVersion\s*=\s*"([^"]+)"/,
      "AuthStore.legalPrivacyVersion",
    );
    expect(
      LEGAL_VERSIONS.tos,
      "web LEGAL_VERSIONS.tos drifted from the iOS legalTosVersion",
    ).toBe(iosTos);
    expect(
      LEGAL_VERSIONS.privacy,
      "web LEGAL_VERSIONS.privacy drifted from the iOS legalPrivacyVersion",
    ).toBe(iosPrivacy);
  });

  it("is a plausible ISO date, not a placeholder", () => {
    // A baseline of "" or "TBD" would make meetsBar() comparisons meaningless
    // and could silently disable the gate.
    for (const [k, v] of Object.entries(LEGAL_VERSIONS)) {
      expect(v, `${k} must be an ISO date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
