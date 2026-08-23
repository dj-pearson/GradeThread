import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ALLOWED } from "../../scripts/lib/unfed-form-fields.mjs";

// US-2802: a provenance badge may not be promised before it can be earned.
//
// The story is named for the discovery that live_capture_opt_in, verified_360_opt_in
// and capture_360 were parsed by routes/grade.ts and sent by nothing, on any
// client, ever. evaluateLiveCapture opens with a hard gate on the opt-in, so
// every submission in the product's history took the "not opted into Live
// Capture" branch and the badge the pipeline calls "the strongest provenance
// tier" had never been earned by anyone.
//
// Live Capture is wired now. Verified 360 is not, and cannot be from a browser:
// verified-360.ts scores photogrammetric and LiDAR coverage a browser has no
// sensor to measure. So it waits on a native depth-capture feature that does not
// exist yet.
//
// WHAT THIS HOLDS, and why a source scan is the right tool for it. The question
// is not "is the badge computed correctly" — that is unit-tested elsewhere — but
// "does any page PROMISE a badge nobody can earn". That is a claim-versus-
// capability question, and the capability is already recorded, precisely, in the
// unfed-field allowlist: a field on that list has never arrived in production.
// So the rule writes itself. Advertise the badge, or leave the field unfed, but
// not both.
//
// This is the same failure US-2809 was filed for, one level deeper. There the
// admin page promised a public changelog that did not exist. Here the risk is a
// FRAUD CLAIM — "proof the photos came straight from your camera" — attached to
// something no seller can obtain, which is worse than a broken link.

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8").replace(/\r\n?/g, "\n");

/**
 * Surfaces that PROMISE. Deliberately not the whole tree.
 *
 * A certificate rendering `{gradeReport.verified_360_badge && …}` is showing a
 * RESULT, and a result that can never be true is dead code rather than a lie.
 * The pages below are the ones that tell someone what they could get: the
 * marketing tree, the SEO copy registry, and the pre-capture seller copy where
 * the choice is actually made.
 */
const PROMISE_SURFACES = ["src/pages/marketing", "src/lib/seo"];
const PROMISE_FILES = ["src/pages/new-submission.tsx"];

/**
 * opt-in field → the BADGE NAME as a user reads it on the page.
 *
 * ⚠ THE NAME, NOT THE FEATURE'S GENERAL VOCABULARY, and the first draft got
 * that wrong. The live pattern was /live[\s-]?verified|live[\s-]?capture/,
 * and the second alternative matches the IDENTIFIER qualifiesForLiveCapture,
 * which new-submission.tsx imports on line 54 and calls on line 933. So when
 * sabotage deleted the actual seller copy — the words offering the badge —
 * the guard stayed green on a function name.
 *
 * A promise is something a person can read. An identifier is not one, and
 * matching it means the check can never tell the copy from the plumbing.
 */
const BADGE_CLAIMS: Record<string, RegExp> = {
  verified_360_opt_in: /verified[\s-]?360|360[\s-]?verified/i,
  live_capture_opt_in: /live[\s-]?verified/i,
};

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Comments removed: prose describing a badge is not a promise made to a user. */
const visible = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

const surfaceFiles = [
  ...PROMISE_SURFACES.flatMap((d) => walk(resolve(ROOT, d))),
  ...PROMISE_FILES.map((f) => resolve(ROOT, f)),
];

describe("US-2802: no page promises a badge that cannot be earned", () => {
  it("the allowlist and the promise surfaces both parsed", () => {
    // Guards the guard. Every assertion below is vacuous against an empty
    // allowlist or an empty file list, and both are one bad path away.
    expect(Object.keys(ALLOWED).length, "the unfed allowlist did not import").toBeGreaterThan(2);
    expect(surfaceFiles.length, "no promise surfaces found").toBeGreaterThan(20);
    expect(
      surfaceFiles.some((f) => f.endsWith("new-submission.tsx")),
      "the pre-capture seller copy is not in the scanned set",
    ).toBe(true);
  });

  it("Verified 360 is unfed, so nothing advertises it", () => {
    // The live case today. If someone builds the native depth capture and feeds
    // verified_360_opt_in, this stops applying on its own — the allowlist entry
    // goes, and the claim becomes fair game.
    expect(
      ALLOWED.verified_360_opt_in,
      "verified_360_opt_in is no longer on the unfed allowlist, so this case has " +
        "nothing to protect. Delete it, and check that whoever wired the field " +
        "also wrote the copy.",
    ).toBeDefined();

    const offenders = surfaceFiles.filter((f) =>
      BADGE_CLAIMS.verified_360_opt_in!.test(visible(readFileSync(f, "utf8"))),
    );
    expect(
      offenders.map((f) => f.replace(ROOT, "")),
      "a seller-facing page advertises Verified 360 while verified_360_opt_in is " +
        "still unfed by every client. No submission can earn it, so the page is " +
        "promising something nobody can get — and this one is a fraud claim, not " +
        "a broken link.",
    ).toEqual([]);
  });

  it("Live Capture IS fed, so advertising it is fair and the seller copy stands", () => {
    // The other half, and the reason this is a coupling rather than a ban. The
    // rule must permit the claim once the capability lands, or it would just be
    // a second place to delete copy from.
    expect(
      ALLOWED.live_capture_opt_in,
      "live_capture_opt_in is back on the unfed allowlist. The seller copy in " +
        "new-submission.tsx promises a Live-Verified badge; if no client sends " +
        "the opt-in again, that promise is unearnable.",
    ).toBeUndefined();

    const promises = surfaceFiles.filter((f) =>
      BADGE_CLAIMS.live_capture_opt_in!.test(visible(readFileSync(f, "utf8"))),
    );
    expect(
      promises.length,
      "nothing mentions Live-Verified on any promise surface. The seller copy " +
        "that offers the badge is the point of wiring it, so its disappearance " +
        "is worth noticing.",
    ).toBeGreaterThan(0);
  });

  it("every badge claim this file knows about names a real opt-in field", () => {
    // An entry for a field the edge no longer parses would be a rule guarding
    // nothing, indistinguishable from a rule that passes.
    const grade = read("services/edge-functions/src/routes/grade.ts");
    for (const field of Object.keys(BADGE_CLAIMS)) {
      expect(grade, `${field} is no longer read by routes/grade.ts`).toContain(field);
    }
  });
});
