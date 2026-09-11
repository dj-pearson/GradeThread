// US-3396: the guard that outlives the nine fixes.
//
// scripts/check-operator-read-checks.mjs is the deliverable; this file is what
// makes it run. vitest.scripts.config.mjs collects `scripts/**/*.test.mjs`, and
// that project runs in `npm run verify` (scripts/verify.mjs "web: script tests")
// and in CI's `npm run test:scripts` step, so no new plumbing was needed.
//
// The assertions split three ways:
//   1. the rules still fire on their own fixtures (selfCheck),
//   2. the two script directories are clean apart from a named allowlist,
//   3. the rules behave on hand-written strings, including the two cases that
//      made the first version of this guard wrong - a variable name reused in a
//      later function, and a `${res.status}` inside a template literal.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  blankNonCode,
  KNOWN_OK,
  listSources,
  REPO_ROOT,
  RULES,
  reconcile,
  run,
  scanSource,
  SELF_CHECK_DIR,
  SUBJECT_ROOTS,
} from "./check-operator-read-checks.mjs";

describe("the subject set is derived from disk, never listed", () => {
  it("reads both script directories and finds the whole corpus", () => {
    const counts = SUBJECT_ROOTS.map((r) => listSources(join(REPO_ROOT, r)).length);
    // Vacuous over an empty list otherwise. 260 non-test scripts were counted
    // by the US-3396 audit; this floor only has to prove the walk happened.
    expect(counts[0]).toBeGreaterThan(150);
    expect(counts[1]).toBeGreaterThan(10);
  });

  it("excludes tests and the self-check fixtures", () => {
    const files = SUBJECT_ROOTS.flatMap((r) => listSources(join(REPO_ROOT, r)));
    expect(files.filter((f) => /\.test\.(mjs|ts)$/.test(f))).toEqual([]);
    expect(files.filter((f) => f.includes("fixtures"))).toEqual([]);
  });

  it("covers scripts the guard's own source never names", () => {
    // The point of deriving the set: a script the guard has never heard of is
    // still a subject. A hard-coded list goes stale the first time somebody
    // adds a file, and it goes stale silently - which is the exact shape this
    // guard exists to catch.
    const source = readFileSync(join(REPO_ROOT, "scripts/check-operator-read-checks.mjs"), "utf8");
    const covered = new Set(
      SUBJECT_ROOTS.flatMap((r) => listSources(join(REPO_ROOT, r))).map((f) =>
        f.slice(REPO_ROOT.length + 1).split("\\").join("/")
      ),
    );
    for (const path of [
      "scripts/verify.mjs",
      "scripts/style-code-coverage.mjs",
      "services/edge-functions/scripts/ai-token-profile.ts",
      "services/edge-functions/scripts/unit-economics.ts",
    ]) {
      expect(covered.has(path), `${path} is not in the derived subject set`).toBe(true);
      expect(source).not.toContain(path);
    }
  });
});

describe("every rule still fires on its own fixture", () => {
  it("selfCheck reports no problems", () => {
    // A rule that matches nothing is not an error in a source scan - it is
    // simply absent from the findings, which reads exactly like a clean
    // codebase. This is the assertion that makes a quiet result trustworthy.
    expect(run().selfCheckProblems).toEqual([]);
  });

  it("the fixtures carry a marked instance of every rule", () => {
    const sources = listSources(join(REPO_ROOT, SELF_CHECK_DIR), { includeFixtures: true })
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    for (const rule of RULES) {
      expect(sources).toContain(`MUST_FIRE ${rule}`);
    }
  });
});

describe("the two script directories are clean", () => {
  it("has no finding outside KNOWN_OK", () => {
    const { unexpected } = reconcile(run().findings);
    expect(
      unexpected.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.snippet}`),
    ).toEqual([]);
  });

  it("has no KNOWN_OK entry that stopped matching", () => {
    // The list can only shrink. A site that was fixed has to be deleted from
    // it, so an entry cannot quietly become cover for a different violation.
    const { stale } = reconcile(run().findings);
    expect(stale.map((e) => `${e.file} :: ${e.snippet}`)).toEqual([]);
  });

  it("gives every KNOWN_OK entry a real reason and a known rule id", () => {
    for (const entry of KNOWN_OK) {
      expect(RULES).toContain(entry.rule);
      expect(entry.why.length).toBeGreaterThan(80);
    }
  });
});

describe("supabase-destructure-drops-error", () => {
  const fire = (src) =>
    scanSource(src, "x.ts").filter((f) => f.rule === "supabase-destructure-drops-error");

  it("fires on data with no error", () => {
    expect(fire(`const { data } = await db.from("users").select("id");`)).toHaveLength(1);
  });

  it("fires on count with no error", () => {
    expect(
      fire(`const { count: n } = await db.from("log").select("id", { count: "exact" });`),
    ).toHaveLength(1);
  });

  it("fires on a renamed data binding", () => {
    expect(fire(`const { data: rows } = await db.from("users").select("id");`)).toHaveLength(1);
  });

  it("does not fire when error is destructured", () => {
    expect(fire(`const { data, error } = await db.from("users").select("id");`)).toEqual([]);
  });

  it("does not fire on a non-supabase await", () => {
    expect(fire(`const { data } = await axios.get("/x");`)).toEqual([]);
  });

  it("does not let a .from( in a LATER statement vouch for this one", () => {
    const src = [
      `const { data } = await loader.load();`,
      `const { data: b, error } = await db.from("users").select("id");`,
    ].join("\n");
    expect(fire(src)).toEqual([]);
  });

  it("ignores a commented-out example", () => {
    expect(fire(`// const { data } = await db.from("users").select("id");`)).toEqual([]);
  });
});

describe("unchecked-fetch-response", () => {
  const fire = (src) =>
    scanSource(src, "x.mjs").filter((f) => f.rule === "unchecked-fetch-response");

  it("fires when the response is never tested", () => {
    expect(fire(`const res = await fetch(u);\nconst body = await res.json();`)).toHaveLength(1);
  });

  it("does not fire when .ok is tested", () => {
    expect(fire(`const res = await fetch(u);\nif (!res.ok) throw new Error("x");`)).toEqual([]);
  });

  it("does not fire when .status is tested", () => {
    expect(fire(`const res = await fetch(u);\nif (res.status !== 200) return null;`)).toEqual([]);
  });

  it("does not fire when .status is read inside a template literal", () => {
    // The first version of this guard blanked template bodies whole and flagged
    // scripts/ops/uptime-check.mjs, which logs `Webhook alert -> ${res.status}`.
    expect(fire("const res = await fetch(u);\nconsole.log(`sent -> ${res.status}`);")).toEqual([]);
  });

  it("does NOT accept a later function's check of the same variable name", () => {
    // `res` is the name at 48 of the 53 candidate sites in this repo, so an
    // unchecked `res` passing because an unrelated function checks its own
    // `res` is not a corner case - it is the default outcome of a naive scan.
    const src = [
      `async function bad() {`,
      `  const res = await fetch(a);`,
      `  return res.json();`,
      `}`,
      `async function good() {`,
      `  const res = await fetch(b);`,
      `  if (!res.ok) throw new Error("x");`,
      `  return res.json();`,
      `}`,
    ].join("\n");
    const hits = fire(src);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(2);
  });

  it("ignores a fetch inside a string or a comment", () => {
    expect(fire(`const usage = "const res = await fetch(u)";`)).toEqual([]);
    expect(fire(`/* const res = await fetch(u); */`)).toEqual([]);
  });
});

describe("blankNonCode", () => {
  it("keeps every character position and every line", () => {
    const src = readFileSync(join(REPO_ROOT, "scripts/check-operator-read-checks.mjs"), "utf8");
    const blanked = blankNonCode(src);
    expect(blanked).toHaveLength(src.length);
    expect(blanked.split("\n")).toHaveLength(src.split("\n").length);
  });

  it("blanks comment and string bodies but keeps template substitutions", () => {
    const blanked = blankNonCode("const a = 1; // gone\nconst b = `kept ${a.status}`;");
    expect(blanked).not.toContain("gone");
    expect(blanked).not.toContain("kept");
    expect(blanked).toContain("a.status");
  });

  it("does not treat a division as the start of a regex", () => {
    const blanked = blankNonCode("const pct = done / total; const x = res.ok;");
    expect(blanked).toContain("res.ok");
  });
});
