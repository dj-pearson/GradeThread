// Guard: the paths CLAUDE.md cites must exist.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { extractPathRefs, missingRefs } from "./doc-refs.mjs";

describe("extractPathRefs", () => {
  it("does not truncate .tsx to .ts or .json to .js", () => {
    // The alternation-ordering bug this guard was born from: with `ts` listed
    // before `tsx`, the pattern matches the head of a .tsx path and reports a
    // .ts file missing. It produced four false positives on the first hand-run.
    const refs = extractPathRefs("see `src/routes/index.tsx` and `dist/seo-manifest.json`");
    expect(refs).toContain("src/routes/index.tsx");
    expect(refs).toContain("dist/seo-manifest.json");
    expect(refs).not.toContain("src/routes/index.ts");
    expect(refs).not.toContain("dist/seo-manifest.js");
  });

  it("ignores globs and placeholders", () => {
    const refs = extractPathRefs(
      "`supabase/migrations/NNNNN_*.sql` and `src/**/*.tsx` and `services/x/{main.ts}`",
    );
    expect(refs).toEqual([]);
  });

  it("picks up top-level docs referenced by name", () => {
    expect(extractPathRefs("see DEPLOY.md and ROLLBACK.md")).toEqual([
      "DEPLOY.md",
      "ROLLBACK.md",
    ]);
  });

  it("de-duplicates and sorts", () => {
    const refs = extractPathRefs("`a/b.ts` then `a/b.ts` then `a/a.ts`");
    expect(refs).toEqual(["a/a.ts", "a/b.ts"]);
  });
});

describe("missingRefs", () => {
  it("reports only what the predicate says is absent", () => {
    expect(missingRefs(["a.ts", "b.ts"], (p) => p === "a.ts")).toEqual(["b.ts"]);
  });

  it("resolves a reference written relative to a doc-known root", () => {
    // CLAUDE.md writes "lib/supabase.ts" inside a paragraph about the edge
    // service, meaning services/edge-functions/src/lib/supabase.ts. That is
    // unambiguous prose, not a broken path, so it must not be reported — a
    // guard that flags correct writing gets switched off, which is how every
    // other unreliable check in this repo ended up ignored.
    const missing = missingRefs(
      ["lib/supabase.ts"],
      (p) => p === "services/edge-functions/src/lib/supabase.ts",
    );
    expect(missing).toEqual([]);
  });

  it("still reports a path that resolves under no root", () => {
    expect(missingRefs(["lib/gone.ts"], () => false)).toEqual(["lib/gone.ts"]);
  });
});

describe("CLAUDE.md", () => {
  it("cites no path that has moved or been deleted", () => {
    // CLAUDE.md is read at the start of every session. A stale path here costs
    // every one of them — the reader hunts for a file that is not there, or
    // trusts a description of code that has moved.
    const refs = extractPathRefs(readFileSync("CLAUDE.md", "utf8"));
    expect(refs.length).toBeGreaterThan(5);
    expect(missingRefs(refs, (p) => existsSync(p))).toEqual([]);
  });
});
