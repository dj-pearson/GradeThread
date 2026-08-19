// US-2681: the cover photo as a retrieval key, not just a nice picture.
//
// eBay image search is a SECOND, SEPARATE INDEX. It embeds the buyer's query
// photo and matches it against listing images, so photo 1 decides whether a
// garment is findable by anyone who searches with a picture or taps "find
// similar". Photo preflight checked pixels and count and never asked that
// question.
//
// Two things these tests exist to hold. First, the checks apply to SLOT 1 ONLY
// — a tag close-up is supposed to fill the frame with a label and a detail shot
// is supposed to be a fragment, so applying a cover rule to them tells the
// seller to ruin a correct photo. Second, "never assessed" must never read as
// "clean": a nudge that claims a check nobody ran is worse than silence,
// because a seller told their cover photo is fine stops looking at it.

import { assert, assertEquals } from "@std/assert";
import "./_env.ts";

const {
  COVER_ISSUE_TYPES,
  QA_ISSUE_TYPES,
  coverPhotoAssessment,
  coverPhotoWarnings,
  isCoverIssue,
  normalizeQaResult,
} = await import("../lib/ai-photo-qa.ts");
const { photoStandardsPreflight } = await import("../lib/publish-preflight.ts");
const { selectListingPhotos } = await import("../lib/listing-photo-budget.ts");

// ── AC5: the implemented list IS the spec ──────────────────────────────────

Deno.test("AC5: the four checks match playbook §11, read from the note itself", async () => {
  // Read the vault note rather than restating what it says. A test that
  // hard-codes the four names passes forever after someone edits §11, which is
  // precisely the drift this assertion is supposed to catch.
  const playbook = await Deno.readTextFile(
    new URL("../../../../vault/30-platform/ebay-ranking-playbook.md", import.meta.url),
  );
  // Whitespace-normalised: the note is hard-wrapped, so "one garment per
  // photo" spans a line break and a raw substring match would miss it.
  const section = playbook
    .slice(playbook.indexOf("11. **Visual retrieval"), playbook.indexOf("12. **Agentic"))
    .replace(/\s+/g, " ");
  assert(section.length > 0, "playbook §11 not found — the cited spec moved");

  // The four properties §11 names, each as the phrase it uses.
  const spec: Array<[string, string]> = [
    ["cover_garment_small", "filling the frame"],
    ["cover_busy_background", "high-contrast background"],
    ["cover_multiple_garments", "one garment per photo"],
    ["cover_prop_in_frame", "no props or hands"],
  ];

  for (const [issueType, phrase] of spec) {
    assert(
      section.includes(phrase),
      `playbook §11 no longer says "${phrase}" — ${issueType} has lost its source`,
    );
    assert(
      (COVER_ISSUE_TYPES as readonly string[]).includes(issueType),
      `${issueType} is named in §11 and is not implemented`,
    );
  }

  // And nothing extra crept in that §11 does not justify.
  assertEquals(COVER_ISSUE_TYPES.length, spec.length);
});

Deno.test("cover issue types are part of the reportable set", () => {
  for (const t of COVER_ISSUE_TYPES) {
    assert((QA_ISSUE_TYPES as readonly string[]).includes(t), `${t} is not reportable`);
    assert(isCoverIssue(t));
  }
  assertEquals(isCoverIssue("blurry"), false);
  assertEquals(isCoverIssue("nonsense"), false);
});

// ── AC2: slot 1 only, enforced rather than requested ───────────────────────

function issue(type: string, photoIndex: number | null) {
  return { type, severity: "medium", message: `${type} on ${photoIndex}`, photo_index: photoIndex };
}

Deno.test("AC2: a cover issue against photo 1 survives normalization", () => {
  const out = normalizeQaResult(80, [issue("cover_busy_background", 1)], 4);
  assertEquals(out.issues.length, 1);
  assertEquals(out.issues[0]!.type, "cover_busy_background");
});

Deno.test("AC2: a cover issue against a LATER photo is dropped outright", () => {
  // A tag close-up filling the frame with a label is correct, and a detail shot
  // is a fragment by design. Reporting either would tell the seller to break a
  // photo that is doing its job.
  const out = normalizeQaResult(80, [issue("cover_garment_small", 3)], 4);
  assertEquals(out.issues, []);
});

Deno.test("AC2: a cover issue with a NULL index is dropped, not treated as set-level", () => {
  // Set-level is meaningful for "no back shot". It is meaningless for a cover
  // check, which is about one specific photo.
  const out = normalizeQaResult(80, [issue("cover_prop_in_frame", null)], 4);
  assertEquals(out.issues, []);
});

Deno.test("AC2: ordinary issues are unaffected at any index", () => {
  const out = normalizeQaResult(80, [issue("blurry", 3), issue("missing_angle", null)], 4);
  assertEquals(out.issues.length, 2);
});

Deno.test("the scope guard survives an out-of-range index too", () => {
  // photo_index 9 with 4 photos normalizes to null, and null is not 1.
  const out = normalizeQaResult(80, [issue("cover_busy_background", 9)], 4);
  assertEquals(out.issues, []);
});

// ── AC6: unknown is not clean ──────────────────────────────────────────────

Deno.test("AC6: an item that was never QA-assessed reports unknown", () => {
  assertEquals(coverPhotoAssessment(null).status, "unknown");
  assertEquals(coverPhotoAssessment(undefined).status, "unknown");
  assertEquals(coverPhotoAssessment({ issues: [] }).status, "clean");
});

Deno.test("AC6: unknown carries no issues, and clean is a different answer", () => {
  const unknown = coverPhotoAssessment(null);
  const clean = coverPhotoAssessment({ issues: [] });
  assertEquals(unknown.issues, []);
  assertEquals(clean.issues, []);
  // Same issue list, different claim. A caller that only looked at issues.length
  // would report a check nobody ran as a passed check.
  assert(unknown.status !== clean.status);
});

Deno.test("only cover issues count toward the cover verdict", () => {
  const assessment = coverPhotoAssessment({
    issues: [storedIssue("blurry", "blurry"), storedIssue("cover_prop_in_frame", "a hand")],
  });
  assertEquals(assessment.status, "issues");
  assertEquals(assessment.issues.length, 1);
  assertEquals(coverPhotoWarnings(assessment), ["a hand"]);
});

// ── AC3: warnings and a nudge, never a blocker ─────────────────────────────

const PHOTO = { photo_type: "front", width: 2000, height: 2000, sort_order: 0 };

/**
 * Build a stored-QA-shaped issue.
 *
 * The preflight takes { type, message } and nothing more, deliberately: it
 * REPORTS cover issues and has no business knowing about severities or photo
 * indices. Going through a function rather than an inline literal keeps that
 * contract narrow instead of widening it to fit a fixture.
 */
function storedIssue(type: string, message: string) {
  const issue: { type: string; message: string; severity: string; photoIndex: number } = {
    type,
    message,
    severity: "medium",
    photoIndex: 1,
  };
  return issue;
}

Deno.test("AC3: cover issues are warnings, and blockers stay empty", () => {
  const out = photoStandardsPreflight([PHOTO], {
    issues: [storedIssue("cover_busy_background", "The background is a patterned duvet.")],
  });
  assertEquals(out.blockers, []);
  assert(out.warnings.includes("The background is a patterned duvet."));
  assert(out.nudge, "no nudge was produced");
  assertEquals(out.coverPhoto.status, "issues");
});

Deno.test("AC3: the reorder nudge wins when both apply", () => {
  // "Your thumbnail is a tag shot" is the bigger problem and has a one-drag
  // fix. Stacking a second nudge under it splits the seller's attention.
  const out = photoStandardsPreflight(
    [{ ...PHOTO, photo_type: "tag" }],
    { issues: [storedIssue("cover_garment_small", "The garment is a small part of the frame.")] },
  );
  assert(out.nudge?.includes("tag"), out.nudge ?? "(no nudge)");
  // The warning is still there; only the nudge slot is contested.
  assert(out.warnings.some((w) => w.includes("small part of the frame")));
});

Deno.test("AC6: no QA result means no cover warning and no cover nudge", () => {
  const out = photoStandardsPreflight([PHOTO]);
  assertEquals(out.coverPhoto.status, "unknown");
  assertEquals(out.nudge, null);
  assertEquals(out.warnings, []);
});

Deno.test("an empty photo set still reports the cover verdict", () => {
  assertEquals(photoStandardsPreflight([]).coverPhoto.status, "unknown");
  assertEquals(photoStandardsPreflight([], { issues: [] }).coverPhoto.status, "clean");
});

// ── AC4: slot 1 prefers a photo with no cover problem ──────────────────────

Deno.test("AC4: a flagged cover photo yields slot 1 to a clean whole-garment shot", () => {
  const out = selectListingPhotos([
    { url: "a", type: "front", coverIssue: true },
    { url: "b", type: "flatlay", coverIssue: false },
    { url: "c", type: "tag" },
  ]);
  assertEquals(out[0]!.url, "b");
});

Deno.test("AC4: with nothing flagged, the existing role ordering is untouched", () => {
  const before = selectListingPhotos([
    { url: "a", type: "front" },
    { url: "b", type: "flatlay" },
    { url: "c", type: "tag" },
  ]);
  const after = selectListingPhotos([
    { url: "a", type: "front", coverIssue: false },
    { url: "b", type: "flatlay", coverIssue: false },
    { url: "c", type: "tag", coverIssue: false },
  ]);
  assertEquals(before.map((p) => p.url), after.map((p) => p.url));
  assertEquals(before[0]!.url, "a");
});

Deno.test("AC4: every candidate flagged means no reorder", () => {
  const out = selectListingPhotos([
    { url: "a", type: "front", coverIssue: true },
    { url: "b", type: "flatlay", coverIssue: true },
  ]);
  assertEquals(out[0]!.url, "a");
});

Deno.test("a TAG shot is never promoted to slot 1, whatever its flags say", () => {
  // The flags are only ever set against slot 1, so a tag shot carrying no flag
  // means nothing was checked — not that it is a good cover. Promoting it would
  // create exactly the situation the reorder nudge exists to complain about.
  const out = selectListingPhotos([
    { url: "a", type: "front", coverIssue: true },
    { url: "b", type: "tag", coverIssue: false },
    { url: "c", type: "detail", coverIssue: false },
  ]);
  assertEquals(out[0]!.url, "a");
});

Deno.test("an UNASSESSED photo does not displace a flagged one", () => {
  // undefined is not false. Reordering on the strength of a check that did not
  // run is the failure this whole story is about.
  const out = selectListingPhotos([
    { url: "a", type: "front", coverIssue: true },
    { url: "b", type: "flatlay" },
  ]);
  assertEquals(out[0]!.url, "a");
});
