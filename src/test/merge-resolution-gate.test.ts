import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { checkFiles, REPORTED_CODES } from "../../scripts/lib/merge-resolution-check.mjs";

// US-3408. The gate between "the conflict markers are gone" and "this file's
// own scope is intact". The fixture is not invented: it is
// src/components/flipdesk/record-sale-dialog.tsx exactly as merge commit
// 40e95fadc left it. That file staged clean, merged clean, and did not compile,
// and the push that carried it used --no-verify.
//
// It is stored as .tsx.txt on purpose. A .tsx under src/ would be in
// tsconfig.app.json's include and `tsc -b` would fail the build on the fixture
// itself, so the guard would have to be deleted to make the tree green.

const ROOT = join(__dirname, "../..");
const FIXTURE = join(ROOT, "src/test/fixtures/merge-resolution/record-sale-dialog-40e95fadc.tsx.txt");

describe("merge-resolution gate (US-3408)", () => {
  const broken = readFileSync(FIXTURE, "utf8");

  it("catches the half-resolved record-sale-dialog at 40e95fadc", () => {
    const { findings } = checkFiles(["src/components/flipdesk/record-sale-dialog.tsx"], {
      root: ROOT,
      projectName: "tsconfig.app.json",
      contents: new Map([["src/components/flipdesk/record-sale-dialog.tsx", broken]]),
    });

    // Both shapes the interleaved resolution produced, and both are load-bearing:
    // the duplicate import is what the eye misses, the missing declarations are
    // what the compiler would have said forty minutes earlier.
    const dup = findings.filter((f) => f.code === 2300).map((f) => f.message);
    expect(dup).toContain("Duplicate identifier 'Select'.");
    expect(dup.length).toBe(10); // five names, reported at both import sites

    const missing = findings
      .filter((f) => f.code === 2304)
      .map((f) => f.message.replace(/^Cannot find name '(.+)'\.$/, "$1"));
    for (const name of [
      "choiceTouched",
      "setDelistStepFor",
      "lastUnitSold",
      "endOthers",
      "supabase",
      "soldListingId",
      "delistStepFor",
      "ItemDelistPanel",
    ]) {
      expect(missing, `${name} was declared by the side the merge dropped`).toContain(name);
    }
  });

  it("says nothing about the same file as it was fixed", () => {
    const { findings, checked } = checkFiles(
      ["src/components/flipdesk/record-sale-dialog.tsx", "src/components/flipdesk/listing-kit.tsx"],
      { root: ROOT },
    );
    expect(checked.length).toBe(2);
    expect(findings).toEqual([]);
  });

  it("reports a leftover conflict marker as its own finding", () => {
    const marked = "const a = 1;\n<<<<<<< HEAD\nconst b = 2;\n=======\nconst b = 3;\n>>>>>>> other\n";
    const { findings } = checkFiles(["src/lib/utils.ts"], {
      root: ROOT,
      contents: new Map([["src/lib/utils.ts", marked]]),
    });
    expect(findings.filter((f) => f.code === 0).map((f) => f.line)).toEqual([2, 4, 6]);
  });

  it("only reports diagnostics a stubbed single-file program can answer honestly", () => {
    // A stub makes every import `any`, so a wrong argument type or a missing
    // export cannot be judged here — reporting those would fail correct code.
    expect([...REPORTED_CODES.keys()].sort()).toEqual([2300, 2304, 2440, 2451]);
  });
});

describe("the gate is wired where --no-verify cannot reach (US-3408)", () => {
  it("ships a reference-transaction hook, executable, that runs the checker", () => {
    const hook = join(ROOT, ".githooks/reference-transaction");
    expect(existsSync(hook), "reference-transaction hook is missing").toBe(true);
    // git refuses to run a hook that is not executable, and it says nothing when
    // it skips one — the exact silence this story is about.
    expect(statSync(hook).mode & 0o111, "hook is not executable").toBeGreaterThan(0);
    const text = readFileSync(hook, "utf8");
    expect(text).toContain("scripts/check-merge-resolution.mjs");
    expect(text, "must only work when a merge is in progress").toContain("MERGE_HEAD");
    expect(text, "must be inert outside the prepared state").toContain('"$1" = "prepared"');
  });

  it("is also a verify lane, so a merge made before the hook existed is still checked", () => {
    const verify = readFileSync(join(ROOT, "scripts/verify.mjs"), "utf8");
    expect(verify).toContain("scripts/check-merge-resolution.mjs");
  });
});

// AC3. The reporting half: a run that is unfinished, or an API that will not
// answer, must not read as green.
describe("CI conclusion reader (US-3408)", () => {
  async function runReader(checkRuns: unknown, extraArgs: string[] = []) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ check_runs: checkRuns }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      return await new Promise<{ code: number; out: string; err: string }>((resolve) => {
        execFile(
          process.execPath,
          [join(ROOT, "scripts/check-ci-conclusion.mjs"), "deadbeefdeadbeef", ...extraArgs],
          {
            cwd: ROOT,
            env: {
              ...process.env,
              GT_CI_API_BASE: `http://127.0.0.1:${port}`,
              GITHUB_TOKEN: "test-token",
              GH_TOKEN: "test-token",
              GITHUB_REPOSITORY: "dj-pearson/GradeThread",
            },
          },
          (err, stdout, stderr) => {
            resolve({
              code: err && typeof err.code === "number" ? err.code : 0,
              out: String(stdout),
              err: String(stderr),
            });
          },
        );
      });
    } finally {
      server.close();
    }
  }

  it("exits 0 and says green only when every run completed successfully", async () => {
    const r = await runReader([
      { name: "CI / build", status: "completed", conclusion: "success" },
      { name: "iOS CI", status: "completed", conclusion: "skipped" },
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("green on deadbeefd");
  });

  it("exits 1 and names the failing check when one is red", async () => {
    const r = await runReader([
      { name: "CI / build", status: "completed", conclusion: "failure", html_url: "http://x/1" },
      { name: "Android CI", status: "completed", conclusion: "success" },
    ]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("RED on deadbeefd");
    expect(r.err).toContain("CI / build");
  });

  it("an unfinished run is UNKNOWN rather than green", async () => {
    const r = await runReader([
      { name: "CI / build", status: "in_progress", conclusion: null },
      { name: "iOS CI", status: "completed", conclusion: "success" },
    ]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("UNKNOWN, not green");
  });

  it("no check runs at all is UNKNOWN rather than green", async () => {
    const r = await runReader([]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("UNKNOWN, not green");
  });
});
