import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MARKETPLACE_SPECS } from "@/lib/marketplace-specs";

// US-3455 -- the iOS list flow table is generated from the extension's
// selectors, and this is what stops the two drifting. The sibling of
// ios-delist-flows-drift.test.ts, for the create form.
//
// Runs in the web lane rather than the iOS one on purpose: it needs node and
// the extension sources, neither of which is macOS-only, so it fails on the
// machine that edited the selectors rather than waiting for iOS CI.

const root = process.cwd();
const GENERATOR = resolve(root, "scripts/gen-ios-list-selectors.mjs");
const GENERATED = resolve(
  root,
  "ios/GradeThread/Marketplaces/WebList/ListFlows.generated.swift",
);

describe("iOS list flows are generated from the extension's selectors", () => {
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
    expect(src).toContain("scripts/gen-ios-list-selectors.mjs");
  });

  it("only marks a platform runnable when the extension has verified its create form", () => {
    const selectors = readFileSync(
      resolve(root, "extension-unified/lister/selectors.js"),
      "utf8",
    );
    const swift = readFileSync(GENERATED, "utf8");
    const table = new Function(
      "self",
      `${selectors}; return self.GT_LISTER_SELECTORS;`,
    )({}) as Record<string, { enabled?: boolean; required?: string[]; liveListingUrlPattern?: string }>;

    for (const platform of ["poshmark", "mercari"]) {
      const verified = table[platform]?.enabled === true;
      const block = swift.slice(swift.indexOf(`"${platform}": Flow(`));
      const declared = /enabled: true,/.test(block.slice(0, 300));
      expect(declared, `${platform} runnable on iOS but not verified on desktop`).toBe(verified);
      // Without a live-listing pattern the phone could never record a post,
      // and every listing made this way would sit unconfirmed.
      expect(table[platform]?.liveListingUrlPattern, `${platform} has no liveListingUrlPattern`).toBeTruthy();
      // The probe list must name the submit control: the run confirms it is
      // on the real form by finding the button it will never press.
      expect(table[platform]?.required ?? []).toContain("submit");
    }
  });

  it("names the same hand-set pickers the web's marketplace specs declare", () => {
    // The generator cannot import the TypeScript spec, so it carries a copy
    // (MANUAL_FIELDS). This reads what that copy produced and is the pin that
    // makes the copy safe to carry.
    const swift = readFileSync(GENERATED, "utf8");
    for (const platform of ["poshmark", "mercari"] as const) {
      const block = swift.slice(swift.indexOf(`"${platform}": Flow(`));
      const match = /manualFields: \[([^\]]*)\]/.exec(block.slice(0, 2000));
      const generated = (match?.[1] ?? "").match(/"([^"]+)"/g)?.map((q) => q.slice(1, -1)) ?? [];
      expect(generated, `${platform} manualFields on iOS`).toEqual(MARKETPLACE_SPECS[platform].manualFields);
    }
  });
});
