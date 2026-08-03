// The documented command must check what CI checks.
//
// THE INCIDENT THIS EXISTS FOR (2026-08-02). `scripts/vault-lint.mjs` escalates
// drift on a `type: contract` note from a WARNING to an ERROR under `--strict`.
// CI ran it with the flag. The npm script `vault:lint` — the one CLAUDE.md and
// the vault skill both tell you to run — did not.
//
// So the documented command printed six drift warnings that read as tolerable,
// and CI failed on those same six as errors. A full day of edits shipped on the
// warning reading, and CI went red on the first push. The failure mode is
// specific and nasty: the local command did not lie about the FACTS, it
// disagreed about the SEVERITY, which is exactly the kind of difference nobody
// re-derives when a check says "OK" at the bottom.
//
// The general rule this guard holds: if a script is documented as the way to
// check something, it must not be weaker than the CI step that gates it. A
// weaker local command is worse than no local command, because it manufactures
// confidence.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("local vault:lint matches what CI runs", () => {
  it("the npm script passes --strict", () => {
    const pkg = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };
    expect(
      pkg.scripts["vault:lint"],
      "vault:lint must run --strict, or the documented command is weaker than " +
        "the CI step it stands in for. The soft view is vault:lint:soft.",
    ).toContain("--strict");
  });

  it("the CI workflow and the verify lane both use --strict", () => {
    // Both directions matter. If CI ever drops the flag, the guard above would
    // keep passing while the gate quietly weakened.
    expect(read(".github/workflows/ci.yml")).toContain("vault-lint.mjs --strict");
    expect(read("scripts/verify.mjs")).toContain("vault-lint.mjs --strict");
  });

  it("the soft variant still exists and is NOT strict", () => {
    // Keeping it is deliberate: an author mid-edit wants to see drift without
    // failing. Removing it would push people back to invoking the script by
    // hand, which is how the divergence started.
    const pkg = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["vault:lint:soft"]).toBeTruthy();
    expect(pkg.scripts["vault:lint:soft"]).not.toContain("--strict");
  });

  it("the docs point at the strict command, not the soft one", () => {
    // A guard on the script alone would not have prevented this: the reason the
    // wrong command got run all day is that two documents told me to run it.
    for (const doc of ["CLAUDE.md", ".claude/skills/vault/SKILL.md"]) {
      const src = read(doc);
      if (!src.includes("vault:lint")) continue;
      expect(
        src,
        `${doc} mentions vault:lint:soft as the routine check — it is the ` +
          `non-failing view, not the gate`,
      ).not.toMatch(/run `npm run vault:lint:soft`/);
    }
  });
});
