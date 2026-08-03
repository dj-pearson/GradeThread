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
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

/**
 * Every markdown file a human or an agent might read for instructions.
 *
 * `vault/90-archive/` is excluded on purpose: archived notes are dated
 * snapshots that must keep saying what was true then. Everything else is live
 * instruction and has to name the real gate.
 */
const SKIP = /^(node_modules|dist|coverage|\.git|ios|android|test-results)$/;
function walkMarkdown(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(resolve(process.cwd(), dir), {
    withFileTypes: true,
  })) {
    const p = dir === "." ? e.name : `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (!SKIP.test(e.name) && p !== "vault/90-archive") walkMarkdown(p, out);
    } else if (e.name.endsWith(".md")) {
      out.push(p);
    }
  }
  return out;
}

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

  // US-2391, the second pair the audit found. Same class, different flag.
  //
  // `npm test` is `vitest run` with NO coverage. CI runs `npm run test:coverage`,
  // and vitest.config.ts sets FAILING thresholds (statements 65, branches 58,
  // functions 62, lines 67). So `npm test` can be green while CI is red on
  // coverage alone — and vault/70-agent/ralph-learnings.md told people to run
  // exactly that to avoid shipping a red main.
  //
  // Resolved by correcting the DOC rather than by making `npm test` slow: a fast
  // inner-loop command is worth having, it just must not be described as the
  // gate. That asymmetry is the reusable part — not every weaker command should
  // be strengthened, but every one of them has to stop claiming to be the gate.
  it("the coverage thresholds CI enforces are real and failing", () => {
    const cfg = read("vitest.config.ts");
    expect(cfg).toMatch(/thresholds:\s*\{/);
    for (const metric of ["statements", "branches", "functions", "lines"]) {
      expect(cfg, `${metric} floor is gone`).toMatch(
        new RegExp(`${metric}:\\s*\\d+`),
      );
    }
    expect(read(".github/workflows/ci.yml")).toContain("npm run test:coverage");
  });

  it("no doc tells you `npm test` is what keeps main green", () => {
    // The specific sentence that misled, pinned. `npm test` may be MENTIONED —
    // it is a real and useful command — but not as the thing standing between
    // you and a red main.
    const doc = read("vault/70-agent/ralph-learnings.md");
    expect(doc).not.toMatch(/`npm test` separately or you ship a red/);
    expect(doc, "the correction should name the gate").toContain("test:coverage");
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

  // US-2391, the THIRD pair. Same class again, and the one with the widest
  // blast radius: CLAUDE.md's own Commands block is where a fresh session looks
  // first.
  //
  // CI (.github/workflows/ci.yml) and scripts/verify.mjs both run `npx tsc -b`.
  // CLAUDE.md and scripts/ralph/CLAUDE.md both said `npx tsc --noEmit`. Those
  // are not two spellings of one check: `-b` follows project references and
  // rejects casts `--noEmit` lets slide, which vault/70-agent/ralph-learnings.md
  // had already recorded — so the correction existed in the vault while the two
  // documents people actually run kept naming the weaker command.
  //
  // Resolved by strengthening the DOC (unlike `npm test`, there is no inner-loop
  // value in the weaker one — `tsc -b` is incremental and not slower).
  it("CI and the verify lane both typecheck with `tsc -b`", () => {
    // Both directions, same as the vault pair: if CI ever drops to `--noEmit`,
    // the doc guard below would keep passing while the gate weakened.
    expect(read(".github/workflows/ci.yml")).toContain("npx tsc -b");
    expect(read("scripts/verify.mjs")).toContain("npx tsc -b");
  });

  it("no doc prescribes `npx tsc --noEmit` as the typecheck", () => {
    // One file mentions the weaker command legitimately. Enumerated with the
    // reason, not skipped by a blanket pattern — a rule broad enough to excuse
    // it would excuse the next regression too.
    //
    // `vault/70-agent/reading-a-red-ci.md` needs no exemption: it runs
    // `npx tsc -p tsconfig.functions.json --noEmit`, a DIFFERENT project. The
    // root build never sees functions/, so that is an extra check rather than a
    // substitute for the gate, and the pattern below does not match it.
    const ALLOWED: Record<string, string> = {
      // Names it in order to say it is NOT enough. That IS the correction.
      "vault/70-agent/ralph-learnings.md":
        "records that --noEmit is weaker than tsc -b",
    };

    const docs = walkMarkdown(".");
    // Canary: the walk must actually reach the file the incident was in. A scan
    // that finds nothing because it searched nowhere reads identically to a
    // clean result.
    expect(docs, "the markdown walk missed CLAUDE.md").toContain("CLAUDE.md");

    const offenders = docs.filter(
      (f) => !(f in ALLOWED) && /npx tsc --noEmit/.test(read(f)),
    );
    expect(
      offenders,
      "these docs name a typecheck weaker than the CI step; CI runs `npx tsc -b`",
    ).toEqual([]);

    // Guard the guard: every allowlist entry must still contain the string it
    // is excused for. A stale exemption is how the next one gets waved through.
    for (const [f, why] of Object.entries(ALLOWED)) {
      expect(read(f), `${f} no longer ${why} — drop its exemption`).toContain(
        "npx tsc --noEmit",
      );
    }
  });
});
