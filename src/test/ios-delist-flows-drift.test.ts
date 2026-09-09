import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-3281 — the iOS delist flow table is generated from the extension's
// selectors, and this is what stops the two drifting.
//
// WHY IT MATTERS MORE THAN A USUAL GENERATED-FILE CHECK. Marketplaces move
// their listing forms without notice, roughly monthly, and the whole selector
// discipline in `extension-unified/lister/selectors.js` exists because a
// selector that misses does not throw: it clicks nothing and the run reports a
// delist that never happened. If iOS carried a hand-kept copy of those
// selectors, the copy would go stale on the exact day the desktop one was
// fixed, and the seller on the phone would be the last to find out.
//
// The generated Swift is COMMITTED and compiled in, which is the other half of
// the point: App Review guideline 4.7 covers software not embedded in the
// binary, and the case for this feature
// (vault/10-ops/ios-webview-delist-app-review.md) rests on the app fetching no
// executable code. So the resolution happens here, at build time, not on a
// device.
//
// Runs in the web lane rather than the iOS one on purpose: it needs node and
// the extension sources, neither of which is macOS-only, so it should fail on
// the machine that edited the selectors rather than waiting for iOS CI.

const root = process.cwd();
const GENERATOR = resolve(root, "scripts/gen-ios-delist-selectors.mjs");
const GENERATED = resolve(
  root,
  "ios/GradeThread/Marketplaces/WebDelist/DelistFlows.generated.swift",
);

describe("iOS delist flows are generated from the extension's selectors", () => {
  it("is not stale", () => {
    const result = spawnSync(process.execPath, [GENERATOR, "--check"], {
      encoding: "utf8",
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(output).not.toContain("stale");
    expect(result.status).toBe(0);
  });

  it("carries the generated header, so nobody edits it by hand", () => {
    const src = readFileSync(GENERATED, "utf8");
    expect(src.startsWith("// GENERATED FILE. DO NOT EDIT.")).toBe(true);
    expect(src).toContain("scripts/gen-ios-delist-selectors.mjs");
  });

  it("only marks a platform runnable when the extension has verified it", () => {
    // The `enabled` flag is the extension's own claim that a human checked
    // those selectors against the live form. Carrying it across unchanged is
    // what stops iOS quietly attempting a draft flow that desktop refuses.
    const selectors = readFileSync(
      resolve(root, "extension-unified/lister/selectors.js"),
      "utf8",
    );
    const swift = readFileSync(GENERATED, "utf8");
    const scope = {} as Record<string, unknown>;
    const table = new Function(
      "self",
      `${selectors}; return self.GT_LISTER_SELECTORS;`,
    )(scope) as Record<string, { delist?: { enabled?: boolean } }>;

    for (const platform of ["poshmark", "mercari", "grailed", "vinted", "facebook"]) {
      const verified = table[platform]?.delist?.enabled === true;
      const block = swift.slice(swift.indexOf(`"${platform}": Flow(`));
      const declared = /enabled: true,/.test(block.slice(0, 300));
      expect(declared, `${platform} runnable on iOS but not verified on desktop`).toBe(
        verified,
      );
    }
  });
});
