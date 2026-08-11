// US-2495: the unwired-module gate's own guard.
//
// The gate exists because a detector nobody runs is the same as no detector —
// `scripts/audit-unwired-exports.mjs` sat executable and unreferenced in every
// npm script, verify lane and workflow, while every hand-run sweep of it found a
// real defect. So the first thing this file pins is the wiring, because that is
// the failure that just happened.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ALLOWED_DEAD_MODULES,
  DOCUMENTED_UNCALLED_BY_DESIGN,
  classify,
  parseDeadModules,
} from "./check-unwired-modules.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

describe("US-2495: the gate is actually wired", () => {
  it("runs in verify AND in CI, not just one of them", () => {
    // US-2402 recorded this exact asymmetry on the UI gate: verify-only meant
    // the pre-push hook was stricter than CI, so `--no-verify` shed the check
    // entirely. Both, or it is a suggestion.
    expect(read("scripts/verify.mjs")).toContain("scripts/check-unwired-modules.mjs");
    expect(read(".github/workflows/ci.yml")).toContain("node scripts/check-unwired-modules.mjs");
  });

  it("has an npm script, so a human can run it without knowing the path", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["unwired:check"]).toBe("node scripts/check-unwired-modules.mjs");
  });
});

describe("US-2495: allowlist hygiene", () => {
  it("every allowed module carries a verdict, not just a name", () => {
    // "known" is not a verdict. The audit's own closing line says a superseded
    // engine and a half-wired feature look identical in its output, so the
    // reason is the only thing that stops the next reader re-deriving it.
    for (const [file, reason] of Object.entries(ALLOWED_DEAD_MODULES)) {
      expect(file, `${file} should be a bare filename`).toMatch(/^[\w.-]+\.ts$/);
      expect(reason.length, `${file}'s reason is too thin to be useful`).toBeGreaterThan(60);
      expect(
        reason,
        `${file} must state WHICH kind of dead it is`,
      ).toMatch(/SUPERSEDED|PENDING|HALF-WIRED/);
    }
  });

  it("a module that is uncalled by design is never also allowlisted", () => {
    // title-sync.ts is the reference the Swift port mirrors and one half of the
    // behavioural parity fixture. Listing it as "dead but allowed" would invite
    // exactly the deletion its module header spends a paragraph forbidding.
    for (const f of DOCUMENTED_UNCALLED_BY_DESIGN) {
      expect(Object.keys(ALLOWED_DEAD_MODULES)).not.toContain(f);
    }
  });
});

describe("US-2495: classify", () => {
  const allowed = { "old.ts": "SUPERSEDED. replaced by the inline path, kept only until the next cleanup pass." };

  it("a new dead module fails", () => {
    const { fresh } = classify(["old.ts", "brand-new.ts"], allowed);
    expect(fresh).toEqual(["brand-new.ts"]);
  });

  it("an allowlisted module that got wired ALSO fails", () => {
    // The quiet direction. An allowlist that outlives its entries silently
    // excuses whatever next takes that filename.
    const { stale } = classify([], allowed);
    expect(stale).toEqual(["old.ts"]);
  });

  it("everything triaged is clean", () => {
    const r = classify(["old.ts"], allowed);
    expect(r.fresh).toEqual([]);
    expect(r.stale).toEqual([]);
  });

  it("a by-design module is neither fresh nor a failure", () => {
    const r = classify([...DOCUMENTED_UNCALLED_BY_DESIGN], allowed);
    expect(r.fresh).toEqual([]);
    expect(r.byDesign.length).toBeGreaterThan(0);
  });
});

describe("US-2495: parsing the audit's output", () => {
  it("reads the module lines and ignores the prose around them", () => {
    const out = [
      "── WHOLE MODULES NOTHING IMPORTS ──────────────────────────────",
      "Every export unwired AND no real import statement anywhere.",
      "",
      "  size-systems.ts                 5 export(s), 58 test refs",
      "  drip-trigger.ts                 4 export(s), 31 test refs",
      "",
      "Dead MODULES are the high-signal hits. Verify each by hand before acting:",
      "a superseded engine (US-933) and a half-wired feature (US-1891) look identical here.",
    ].join("\n");
    expect(parseDeadModules(out)).toEqual(["size-systems.ts", "drip-trigger.ts"]);
  });

  it("reads the '(none)' case as an empty list rather than as a filename", () => {
    expect(parseDeadModules("── WHOLE MODULES ──\n\n  (none)\n")).toEqual([]);
  });

  it("survives CRLF, since the audit is spawned on Windows too", () => {
    const out = "  a.ts                 1 export(s), 0 test refs\r\n  b.ts   2 export(s), 3 test refs\r\n";
    expect(parseDeadModules(out)).toEqual(["a.ts", "b.ts"]);
  });
});
