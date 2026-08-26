import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { checkConfig, dexContains } from "../android/scripts/check-release-config.mjs";

// US-2892: the release lane asserted five secrets and every one of them was
// about signing and uploading. A build missing SUPABASE_ANON_KEY is signed,
// versioned, under budget and crashes on launch for every user — because
// `secret()` defaults that key to an empty string and
// AppConfig.validateAtStartup() throws on it.
//
// These assertions are about the CONTRACT, not the mechanics. The script's own
// --self-test covers the zip/dex plumbing against a real deflated archive; what
// is pinned here is the part a future edit could quietly get wrong: which keys
// are fatal, which only warn, and the fact that the workflows actually call it.

const root = resolve(import.meta.dirname, "..");
const script = resolve(root, "android/scripts/check-release-config.mjs");

/** A dex-shaped buffer containing exactly the strings passed in. */
const dexWith = (...values) => Buffer.from(`dex\n035\0 ${values.join(" ")} `, "utf8");

const GOOD = {
  SUPABASE_URL: "https://api.example.invalid",
  // DELIBERATELY not JWT-shaped. A real anon key is a JWT, and a realistic
  // fixture trips gitleaks' generic-api-key rule on entropy alone - which
  // blocks the commit and, worse, teaches the next person to add an
  // allowlist entry that then covers real keys too. checkConfig does a
  // literal byte search, so the shape is irrelevant to what is tested.
  SUPABASE_ANON_KEY: "fixture-anon-key-not-a-real-credential",
  EDGE_API_URL: "https://functions.example.invalid",
};
const goodDex = () => dexWith(...Object.values(GOOD));

describe("check-release-config: which keys are fatal", () => {
  it("passes when every required value is in the binary", () => {
    expect(checkConfig(goodDex(), GOOD).failures).toEqual([]);
  });

  // One case per required key rather than a loop with a shared assertion, so a
  // failure names the key.
  for (const key of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "EDGE_API_URL"]) {
    it(`fails when ${key} is missing from the environment`, () => {
      const { failures } = checkConfig(goodDex(), { ...GOOD, [key]: "" });
      expect(failures.some((f) => f.startsWith(key))).toBe(true);
    });
  }

  it("treats whitespace as absent, because AppConfig does", () => {
    // ConfigValidation.blankToNull trims first: "  " reads as absent at
    // runtime, so a check that accepted it would pass a crashing build.
    const { failures } = checkConfig(goodDex(), { ...GOOD, SUPABASE_ANON_KEY: "   " });
    expect(failures.some((f) => f.startsWith("SUPABASE_ANON_KEY"))).toBe(true);
  });

  it("fails when the value is in the environment but never reached the binary", () => {
    // The whole reason this reads the artifact instead of just the env: a
    // renamed buildConfigField or a stale Gradle cache passes an env check.
    const { failures } = checkConfig(goodDex(), { ...GOOD, SUPABASE_ANON_KEY: "never-compiled-in" });
    expect(failures.some((f) => f.includes("NOT in the built artifact"))).toBe(true);
  });
});

describe("check-release-config: which keys only warn", () => {
  it("warns but never fails on absent optional config", () => {
    const { failures, warnings } = checkConfig(goodDex(), GOOD);
    expect(failures).toEqual([]);
    // A fork or a PR build legitimately has none of these; failing would make
    // the gate unrunnable for everyone without production secrets.
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("names all four FIREBASE_* keys, since push needs every one", () => {
    const { warnings } = checkConfig(goodDex(), GOOD);
    for (const key of ["FIREBASE_PROJECT_ID", "FIREBASE_APP_ID", "FIREBASE_API_KEY", "FIREBASE_SENDER_ID"]) {
      expect(warnings.some((w) => w.startsWith(key))).toBe(true);
    }
  });

  it("says what ships dead rather than only that a key is missing", () => {
    // "SENTRY_DSN absent" is a fact nobody acts on; "crash reporting ships
    // DISABLED" is the thing worth stopping a release over.
    const { warnings } = checkConfig(goodDex(), GOOD);
    expect(warnings.find((w) => w.startsWith("SENTRY_DSN"))).toMatch(/DISABLED/);
  });

  it("stops warning once an optional value is actually present", () => {
    const dsn = "https://k@sentry.example.invalid/1";
    const { warnings } = checkConfig(dexWith(...Object.values(GOOD), dsn), { ...GOOD, SENTRY_DSN: dsn });
    expect(warnings.some((w) => w.startsWith("SENTRY_DSN"))).toBe(false);
  });
});

describe("check-release-config: the search can say no", () => {
  it("does not report an absent string as present", () => {
    // A matcher that always returns true turns every run into a false pass,
    // which is indistinguishable from a correctly configured build.
    expect(dexContains(goodDex(), "not-in-this-dex")).toBe(false);
  });
});

describe("check-release-config: the self-test runs", () => {
  it("exits zero", () => {
    // Guards the guard: the plumbing self-test must stay runnable, because
    // both workflows invoke it before trusting a result.
    expect(() => execFileSync(process.execPath, [script, "--self-test"], { encoding: "utf8" })).not.toThrow();
  });
});

describe("check-release-config: the workflows call it", () => {
  const release = readFileSync(resolve(root, ".github/workflows/android-release.yml"), "utf8");
  const ci = readFileSync(resolve(root, ".github/workflows/android-ci.yml"), "utf8");

  it("the release lane asserts the three startup-fatal keys before building", () => {
    // Before the build, so a missing value costs seconds rather than the
    // twenty minutes it takes to reach the upload step.
    for (const key of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "EDGE_API_URL"]) {
      expect(release).toMatch(new RegExp(`:\\s*"\\$\\{${key}:\\?`));
    }
  });

  it("the release lane checks the finished bundle, not only the environment", () => {
    expect(release).toMatch(/check-release-config\.mjs app\/build\/outputs\/bundle\/release\/app-release\.aab/);
  });

  it("the release lane self-tests before it trusts the check", () => {
    expect(release).toMatch(/check-release-config\.mjs --self-test/);
  });

  it("CI runs the self-test but not the real check", () => {
    // CI builds release with empty placeholders on purpose, so the real check
    // would fail every PR for a correct reason and train everyone to ignore it.
    expect(ci).toMatch(/check-release-config\.mjs --self-test/);
    expect(ci).not.toMatch(/check-release-config\.mjs app\//);
  });

  it("the release lane pins Node rather than inheriting the runner's", () => {
    expect(release).toMatch(/actions\/setup-node/);
  });
});

describe("check-release-config: no secret ever leaves the process", () => {
  it("reports names and consequences, never values", () => {
    const secret = "fixture-SUPER-SECRET-VALUE-not-a-real-credential";
    const { failures, warnings, ok } = checkConfig(goodDex(), {
      ...GOOD,
      SUPABASE_ANON_KEY: secret, // set, but not in this dex -> a failure line
    });
    const everything = [...failures, ...warnings, ...ok].join("\n");
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain("SUPER-SECRET-VALUE");
  });

  it("does not print a value even when it IS present", () => {
    const { ok, warnings, failures } = checkConfig(goodDex(), GOOD);
    const everything = [...failures, ...warnings, ...ok].join("\n");
    expect(everything).not.toContain(GOOD.SUPABASE_ANON_KEY);
  });
});
