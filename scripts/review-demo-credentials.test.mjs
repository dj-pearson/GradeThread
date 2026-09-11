// US-3393: the App Review demo credentials must never be committable.
//
// `ios/fastlane/metadata/review_information/demo_password.txt` is TRACKED by git
// and is not gitignored, so anything written there is one `git add -A` away from
// being a committed production credential.
//
// AND THE DEFAULT SECRET SCAN DOES NOT CATCH IT. Measured 2026-09-11 with
// gitleaks 8.30.1 (the version .githooks/pre-commit and secret-scan.yml both
// pin) against a throwaway repo mirroring the path: a bare one-line password
// staged at that path returned "no leaks found" in all three shapes tried
// (32-char alphanumeric, 32-char with symbols, 44-char base64). The same value
// written as `password = "..."` at the SAME path DID fire, so the path is not
// allowlisted - the generic rule just has no keyword next to a value that is the
// entire file. A file whose whole contents are the secret is the blind spot.
//
// So the defence is three things that have to agree, and this test is what makes
// them agree:
//   1. the tracked files hold the placeholder and nothing else;
//   2. scripts/seed-review-demo-account.mjs writes no file at all;
//   3. .gitleaks.toml carries a rule that treats ANY non-placeholder content at
//      those two paths as a finding.
//
// Note on (3): the assertions below re-implement the rule's regexes with JS
// RegExp. gitleaks runs Go RE2. For these patterns the two agree, but this test
// proves the CONFIG still says what we think it says - it is not a substitute
// for having run gitleaks, which is recorded in the story note.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REVIEW_INFO = "ios/fastlane/metadata/review_information";

const PLACEHOLDERS = {
  "demo_user.txt": "REVIEW_DEMO_EMAIL_PLACEHOLDER@gradethread.com",
  "demo_password.txt": "REVIEW_DEMO_PASSWORD_PLACEHOLDER",
};

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

function isTracked(rel) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", "--", rel], {
      cwd: ROOT,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

describe("US-3393: App Review demo credentials cannot reach a commit", () => {
  for (const [name, placeholder] of Object.entries(PLACEHOLDERS)) {
    const rel = `${REVIEW_INFO}/${name}`;

    it(`${name} is still tracked, so fastlane deliver keeps finding it`, () => {
      // Untracking these naively is the wrong fix: deliver reads the
      // review_information directory off disk, and a missing file is a missing
      // App Review field. The file stays; only its CONTENT is constrained.
      expect(isTracked(rel), `${rel} should be tracked by git`).toBe(true);
    });

    it(`${name} holds only its placeholder`, () => {
      const actual = read(rel).trim();
      // Deliberately not interpolating `actual` into the message: if this fails
      // it is because a live credential is sitting there, and the assertion
      // message ends up in CI logs.
      expect(
        actual === placeholder,
        `${rel} is not the committed placeholder. A local \`fastlane release\` run ` +
          `leaves the REAL App Review credentials in these tracked files ` +
          `(Fastfile: inject_review_credentials). Restore them with ` +
          `\`git checkout -- ${REVIEW_INFO}/\` before committing. The actual value is ` +
          `not printed here on purpose.`,
      ).toBe(true);
    });
  }

  it("the Fastfile placeholder constants match the files byte for byte", () => {
    const fastfile = read("ios/fastlane/Fastfile");
    // The release lane refuses to submit while the files still equal these, so a
    // drift between the constants and the files silently disarms that guard.
    expect(fastfile).toContain(
      `REVIEW_DEMO_EMAIL_PLACEHOLDER = "${PLACEHOLDERS["demo_user.txt"]}"`,
    );
    expect(fastfile).toContain(
      `REVIEW_DEMO_PASSWORD_PLACEHOLDER = "${PLACEHOLDERS["demo_password.txt"]}"`,
    );
  });

  it("the seeding script writes no file at all", () => {
    const src = read("scripts/seed-review-demo-account.mjs");
    // US-3393 removed `writeFileSync(join(dir, "demo_password.txt"), password)`.
    // Nothing about that path is safe to write, and the script has no other
    // reason to write anything, so the rule is simply: no write primitives.
    for (const primitive of [
      "writeFileSync",
      "writeFile",
      "appendFileSync",
      "appendFile",
      "createWriteStream",
      "cpSync",
      "copyFileSync",
      "Deno.writeTextFile",
    ]) {
      expect(
        src.includes(primitive),
        `scripts/seed-review-demo-account.mjs uses ${primitive}. That script handles a ` +
          `live production password; it must not write to disk. If a write is genuinely ` +
          `needed, it goes to a gitignored path and this test changes deliberately.`,
      ).toBe(false);
    }
  });

  it("the script refuses to run before touching prod if the tracked files are dirty", () => {
    const src = read("scripts/seed-review-demo-account.mjs");
    expect(src).toContain("assertTrackedPlaceholdersIntact");
    // Order matters: the refusal has to happen before any Supabase call, or the
    // operator learns about it after a production password reset.
    const guardAt = src.indexOf("\nassertTrackedPlaceholdersIntact();");
    const clientAt = src.indexOf("createClient(url, key");
    expect(guardAt, "the guard must be called at top level").toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(clientAt);
  });
});

describe("US-3393: .gitleaks.toml closes the bare-password blind spot", () => {
  const config = read(".gitleaks.toml");

  it("defines the demo-credential rule", () => {
    expect(config).toContain('id = "gradethread-appreview-demo-credential"');
  });

  it("the rule's path regex covers both credential files and nothing else nearby", () => {
    const match = config.match(/id = "gradethread-appreview-demo-credential"[\s\S]*?path = '''(.+?)'''/);
    expect(match, "rule must declare a path").not.toBeNull();
    const pathRe = new RegExp(match[1]);
    expect(pathRe.test(`${REVIEW_INFO}/demo_password.txt`)).toBe(true);
    expect(pathRe.test(`${REVIEW_INFO}/demo_user.txt`)).toBe(true);
    // notes.txt is prose the operator maintains; scanning it would be noise.
    expect(pathRe.test(`${REVIEW_INFO}/notes.txt`)).toBe(false);
    expect(pathRe.test(`${REVIEW_INFO}/phone_number.txt`)).toBe(false);
  });

  it("the rule fires on any content and is excused only by the exact placeholders", () => {
    const ruleBlock = config.slice(config.indexOf('id = "gradethread-appreview-demo-credential"'));
    const contentRe = new RegExp(ruleBlock.match(/\n  regex = '''(.+?)'''/)[1]);
    // A weak password must be a finding too - entropy is precisely what the
    // default rules used to decide this was fine.
    expect(contentRe.test("hunter2")).toBe(true);
    expect(contentRe.test(PLACEHOLDERS["demo_password.txt"])).toBe(true);

    const allowed = [...ruleBlock.matchAll(/\n      '''(.+?)''',/g)].map((m) => m[1]);
    expect(allowed.length).toBe(2);
    const excused = (value) => allowed.some((re) => new RegExp(re).test(value));
    expect(excused(PLACEHOLDERS["demo_password.txt"])).toBe(true);
    expect(excused(PLACEHOLDERS["demo_user.txt"])).toBe(true);
    // The anchors have to hold: a real value that merely CONTAINS the
    // placeholder text must still be a finding.
    expect(excused(`${PLACEHOLDERS["demo_password.txt"]}x`)).toBe(false);
    expect(excused("appreview@gradethread.com")).toBe(false);
  });
});
