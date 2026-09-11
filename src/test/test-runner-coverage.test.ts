import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-3343: every file shaped like a test is claimed by a runner something runs.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The story was filed on the belief that scripts/operator-scripts-start.test.mjs
// ran nowhere: it is a vitest suite, and vitest.config.ts includes only
// `src/**/*.{test,spec}.{ts,tsx}`. That reasoning stopped one file too early.
// There is a SECOND vitest project, vitest.scripts.config.mjs, whose include is
// `scripts/**/*.test.mjs`, and it is run by `npm run test:scripts` from both
// scripts/verify.mjs and ci.yml. The suite was wired the whole time and passes
// 23/23.
//
// The alarm was wrong and the QUESTION was right. Nothing in the repo could
// answer "does anything run this file?" without a person reconstructing the
// runner list by hand, which is how a wrong answer got written down. So this
// file makes the answer mechanical: enumerate the runners once, enumerate the
// test-shaped files, and fail when the two sets stop covering each other.
//
// The sweep that produced it found exactly one genuine orphan, and it was NOT
// test-shaped: scripts/verify-lister-selectors.mjs, a gate whose own header
// said "It is wired into scripts/test-extensions.mjs" while nothing invoked it
// anywhere. It is wired in now. Filename shape was not what gave it away, which
// is why src/test/guard-lane-parity.test.ts owns the other half of this
// question — that a GATE is reachable from a lane — and this file owns the
// question of whether a TEST FILE is collected at all.
//
// ── THE TWO WAYS THIS GOES WRONG, BOTH COVERED ───────────────────────────────
// 1. A file is added where no runner looks (a .test.ts under scripts/, a
//    _test.ts outside services/edge-functions/). It reads as coverage forever.
// 2. A runner stops being invoked, or its glob is narrowed, and every file it
//    used to claim orphans at once. This is the expensive direction: deleting
//    the "Test (scripts)" step from ci.yml and the one line in verify.mjs would
//    silently retire 43 suites, and nothing else in the repo would notice.
//
// ── NOTHING HERE HARD-CODES A GLOB IT COULD READ ─────────────────────────────
// The two vitest includes are parsed OUT OF the config files and compared with
// the matchers below, because a remembered copy of a value that lives somewhere
// else can only go stale (see the AASA case in the guards-that-do-not-guard
// notes). The other runners have no greppable glob — Deno's discovery is built
// into `deno test`, Gradle's is a source set, Xcode's is a target — so those are
// declared here with the file that defines them named in the comment.

const ROOT = process.cwd();
const sh = (cmd: string) =>
  execSync(cmd, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

const repoFiles = (): string[] => [
  ...new Set([
    ...sh("git ls-files"),
    ...sh("git ls-files --others --exclude-standard"),
  ]),
];

const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const PKG = read("package.json");
const VERIFY = read("scripts/verify.mjs");
const WORKFLOWS = sh("git ls-files .github/workflows")
  .filter((f) => /\.ya?ml$/.test(f))
  .map(read)
  .join("\n");

// ── what counts as "shaped like a test" ──────────────────────────────────────
//
// AUTHORED WITH Write, NOT THROUGH A SHELL. The first draft of this sweep was
// built in a bash heredoc and its `\\.` collapsed to `.`, so `-spec.ts` matched
// `.spec.` and two ordinary edge libs (cover-photo-spec.ts, openapi-spec.ts)
// reported as orphaned test files. That is failure mode 4 in the
// guards-that-do-not-guard notes, hit while writing a guard against guards.
// The self-check at the bottom pins both directions of it.
const SCRIPT_EXT = "(?:ts|tsx|mts|cts|js|mjs|cjs|jsx)";
const SHAPED_SCRIPT = new RegExp(
  `(?:\\.|_)(?:test|spec)\\.${SCRIPT_EXT}$|^(?:test|bench)\\.${SCRIPT_EXT}$`,
);

function isTestShaped(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  if (SHAPED_SCRIPT.test(base)) return true;
  // Swift and Kotlin carry the convention in the TYPE name, so the file name is
  // the only thing to go on: FooTests.swift, FooTest.kt.
  if (path.startsWith("ios/") && /Tests?\.swift$/.test(base)) return true;
  if (path.startsWith("android/") && /Tests?\.kt$/.test(base)) return true;
  return false;
}

type Runner = {
  /** How it shows up in a report. */
  name: string;
  /** Files this runner collects. */
  claims: (path: string) => boolean;
  /** Substrings proving a human or CI actually starts it. */
  invokedBy: { in: string; needle: string }[];
};

const LANE = "scripts/verify.mjs";
const CI = ".github/workflows/*";

const RUNNERS: Runner[] = [
  {
    // vitest.config.ts `include`, asserted against the file below.
    name: "vitest:web",
    claims: (p) => /^src\/.*\.(?:test|spec)\.(?:ts|tsx)$/.test(p),
    invokedBy: [
      { in: LANE, needle: "npm run test:coverage" },
      { in: CI, needle: "npm run test:coverage" },
    ],
  },
  {
    // vitest.scripts.config.mjs `include`, asserted against the file below.
    // This is the runner the story believed did not exist.
    name: "vitest:scripts",
    claims: (p) => /^scripts\/.*\.test\.mjs$/.test(p),
    invokedBy: [
      { in: LANE, needle: "npm run test:scripts" },
      { in: CI, needle: "npm run test:scripts" },
    ],
  },
  {
    // `deno test` with no path argument, cwd services/edge-functions. Deno's
    // built-in discovery: *_test.*, *.test.*, test.*. There is no `exclude` in
    // services/edge-functions/deno.json, so it walks the whole package.
    name: "deno test (edge)",
    claims: (p) =>
      p.startsWith("services/edge-functions/") &&
      SHAPED_SCRIPT.test(p.split("/").pop() ?? ""),
    invokedBy: [
      { in: LANE, needle: "deno test" },
      { in: CI, needle: "deno test" },
    ],
  },
  {
    // scripts/test-extensions.mjs discovers *.test.cjs under the two dirs it
    // lists. The extensions ship unpacked and carry no framework runner.
    name: "test-extensions",
    claims: (p) => /^extension-(?:condition|unified)\/test\/.*\.test\.cjs$/.test(p),
    invokedBy: [
      { in: LANE, needle: "scripts/test-extensions.mjs" },
      { in: CI, needle: "scripts/test-extensions.mjs" },
    ],
  },
  {
    // playwright.config.ts `testDir: "./e2e"`.
    name: "playwright",
    claims: (p) => /^e2e\/.*\.spec\.ts$/.test(p),
    invokedBy: [
      { in: LANE, needle: "npm run e2e" },
      { in: CI, needle: "npm run e2e" },
    ],
  },
  {
    // Gradle's `test` source set. Runs on Windows; verify:android mirrors CI.
    name: "gradle unit",
    claims: (p) => p.startsWith("android/app/src/test/"),
    invokedBy: [
      { in: LANE, needle: "testDebugUnitTest" },
      { in: CI, needle: "testDebugUnitTest" },
    ],
  },
  {
    // Gradle's `androidTest` source set. CI ONLY, and legitimately so: it needs
    // a booted emulator, which the pre-push hook has no business starting.
    // android-ci.yml compiles it on every run (assembleDebugAndroidTest) and
    // executes it on the managed device.
    name: "gradle androidTest",
    claims: (p) => p.startsWith("android/app/src/androidTest/"),
    invokedBy: [{ in: CI, needle: "connectedDebugAndroidTest" }],
  },
  {
    // ios/project.yml target GradeThreadTests, in the app scheme's testTargets.
    // CI ONLY: xcodebuild is macOS-only and this repo is developed on Windows.
    name: "xcode GradeThreadTests",
    claims: (p) => p.startsWith("ios/GradeThreadTests/"),
    invokedBy: [{ in: CI, needle: "-scheme GradeThread \\" }],
  },
  {
    // ios/project.yml target GradeThreadUITests. NOT in the app scheme's
    // testTargets and that is correct — it is driven by its own scheme from
    // ios-ci.yml, ios-smoke.yml and ios-release.yml, which is why a reader
    // checking only project.yml's `scheme:` block would call these orphaned.
    name: "xcode GradeThreadUITests",
    claims: (p) => p.startsWith("ios/GradeThreadUITests/"),
    invokedBy: [{ in: CI, needle: "GradeThreadUITests" }],
  },
  {
    // ios/Packages/*/Tests — a SwiftPM test target, built and run on LINUX by
    // ios-core-package.yml. These sit outside ios/GradeThreadTests/ and so look
    // orphaned to anyone who assumes the Xcode target is the only Swift runner.
    name: "swift test (GradeThreadCore)",
    claims: (p) => /^ios\/Packages\/[^/]+\/Tests\//.test(p),
    invokedBy: [{ in: CI, needle: "swift test" }],
  },
];

function haystack(where: string): string {
  return where === LANE ? VERIFY : WORKFLOWS;
}

describe("US-3343: every test-shaped file has a runner", () => {
  const shaped = repoFiles().filter(isTestShaped);

  it("finds a real set of test files", () => {
    // Guards the guard: every assertion below is vacuous over an empty list,
    // and a broken classifier empties it silently.
    expect(shaped.length).toBeGreaterThan(1500);
  });

  it("no test-shaped file is collected by nothing", () => {
    const orphans = shaped.filter((p) => !RUNNERS.some((r) => r.claims(p)));
    expect(
      orphans,
      `these are named like tests and no runner collects them, so they read as ` +
        `coverage while executing never:\n  ${orphans.join("\n  ")}\n` +
        `Either wire the file into a lane, delete it, or add the runner that ` +
        `does collect it to RUNNERS in this file.`,
    ).toEqual([]);
  });

  it("every runner still claims files", () => {
    // The other direction, and the expensive one: a glob narrowed or a
    // directory renamed orphans a whole lane at once, and a runner that
    // collects nothing passes green in about a second.
    const empty = RUNNERS.filter((r) => !shaped.some((p) => r.claims(p))).map(
      (r) => r.name,
    );
    expect(
      empty,
      `these runners collect ZERO files: ${empty.join(", ")}. A lane that ` +
        `matches nothing reports success without running anything.`,
    ).toEqual([]);
  });

  it("every runner is actually invoked by a lane or a workflow", () => {
    const broken: string[] = [];
    for (const r of RUNNERS) {
      for (const { in: where, needle } of r.invokedBy) {
        if (!haystack(where).includes(needle)) {
          broken.push(`${r.name}: "${needle}" no longer appears in ${where}`);
        }
      }
    }
    expect(
      broken,
      `a runner stopped being started, which orphans every file it collects ` +
        `at once:\n  ${broken.join("\n  ")}`,
    ).toEqual([]);
  });

  it("the scripts lane is reachable end to end, not just present", () => {
    // The story's own file. The chain is package.json -> the second vitest
    // config -> verify.mjs and ci.yml, and breaking ANY link retires 43 suites
    // while every one of them still looks like a test on disk.
    expect(PKG).toContain("vitest run --config vitest.scripts.config.mjs");
    expect(PKG).toContain('"test:scripts"');
    expect(VERIFY).toContain("npm run test:scripts");
    expect(WORKFLOWS).toContain("npm run test:scripts");

    const claimed = repoFiles().filter((p) =>
      RUNNERS.find((r) => r.name === "vitest:scripts")!.claims(p),
    );
    expect(claimed).toContain("scripts/operator-scripts-start.test.mjs");
    expect(claimed.length).toBeGreaterThanOrEqual(40);
  });
});

describe("US-3343: the runner globs match the configs they describe", () => {
  // Derived, not remembered. If someone narrows an include, this fails here
  // with the reason rather than silently shrinking what gets collected.
  const includeOf = (file: string): string[] => {
    const m = /include:\s*\[([^\]]*)\]/.exec(read(file));
    expect(m, `no include: [...] found in ${file}`).not.toBeNull();
    const body = m?.[1] ?? "";
    return [...body.matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1]!);
  };

  it("vitest.config.ts still collects src/**/*.{test,spec}.{ts,tsx}", () => {
    expect(includeOf("vitest.config.ts")).toEqual([
      "src/**/*.{test,spec}.{ts,tsx}",
    ]);
  });

  it("vitest.scripts.config.mjs still collects scripts/**/*.test.mjs", () => {
    expect(includeOf("vitest.scripts.config.mjs")).toEqual([
      "scripts/**/*.test.mjs",
    ]);
  });

  it("playwright still points at e2e/", () => {
    expect(read("playwright.config.ts")).toContain('testDir: "./e2e"');
  });
});

describe("US-3343: the classifier itself", () => {
  it("recognises every shape this repo uses", () => {
    for (const p of [
      "src/test/foo.test.ts",
      "src/lib/__tests__/foo.spec.tsx",
      "scripts/foo.test.mjs",
      "services/edge-functions/src/tests/foo_test.ts",
      "extension-unified/test/foo.test.cjs",
      "e2e/foo.spec.ts",
      "ios/GradeThreadTests/FooTests.swift",
      "android/app/src/test/java/com/gradethread/app/FooTest.kt",
    ]) {
      expect(isTestShaped(p), `${p} should be test-shaped`).toBe(true);
    }
  });

  it("does not fire on ordinary source that merely contains test or spec", () => {
    // These two really were reported as orphaned test files by the first draft,
    // whose escaped dot was eaten in transit. A hyphen is not a dot.
    for (const p of [
      "services/edge-functions/src/lib/cover-photo-spec.ts",
      "services/edge-functions/src/lib/openapi-spec.ts",
      "services/edge-functions/src/lib/marketplace-specs.ts",
      "android/app/src/main/java/com/gradethread/app/ui/TestTags.kt",
      "ios/GradeThread/Testing/UITestSupport.swift",
      "src/lib/latest-run.ts",
    ]) {
      expect(isTestShaped(p), `${p} should NOT be test-shaped`).toBe(false);
    }
  });
});
