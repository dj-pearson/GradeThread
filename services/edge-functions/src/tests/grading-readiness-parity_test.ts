// US-2019 — EDGE half of the shared grading-readiness guard.
//
// gradingReadinessBlockers is the AUTHORITY: /validate and /submit both gate on
// it. src/lib/grading-readiness.ts mirrors it so the web "Submit for grading"
// card can show readiness live. Two projects, no shared import — so one fixture,
// asserted by both suites, is the only thing that keeps them honest.
//
// See vault/70-agent/guards-that-cannot-fail.md: a mirror pinned by a comment
// is the shape that has already shipped wrong twice in this repo.

import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { gradingReadinessBlockers } = await import(
  "../routes/flipdesk-grading.ts"
);

const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../../../../src/test/fixtures/grading-readiness-cases.json",
      import.meta.url,
    ),
  ),
) as {
  cases: Array<{
    name: string;
    input: {
      garment_type: string | null;
      garment_category: string | null;
      title: string | null;
      photoTypes: string[];
    };
    expected: { blockers: string[]; warnings: string[]; missingPhotos: string[] };
  }>;
};

Deno.test("edge grading readiness matches the cross-project fixture", () => {
  assertEquals(
    fixture.cases.length > 10,
    true,
    "fixture looks truncated — it should cover a broad spread of states",
  );
  for (const c of fixture.cases) {
    const got = gradingReadinessBlockers({
      garment_type: c.input.garment_type,
      garment_category: c.input.garment_category,
      title: c.input.title,
      photoTypes: c.input.photoTypes,
    });
    assertEquals(got.blockers, c.expected.blockers, `case: ${c.name}`);
    assertEquals(got.warnings, c.expected.warnings, `case: ${c.name}`);
    assertEquals(got.missingPhotos, c.expected.missingPhotos, `case: ${c.name}`);
  }
});

Deno.test("edge: a defect photo does NOT satisfy the fabric close-up rule", () => {
  // Still not a substitute: a defect shot frames the flaw, not the weave. What
  // changed in US-2397 is the CONSEQUENCE — it warns and caps the grade instead
  // of refusing the submission.
  const got = gradingReadinessBlockers({
    garment_type: "jeans",
    garment_category: "denim",
    title: "X",
    photoTypes: ["front", "back", "defect"],
  });
  assertEquals(
    got.warnings.some((w) => w.includes("fabric close-up")),
    true,
  );
});

Deno.test("edge: a missing fabric close-up no longer blocks submission", () => {
  // US-2397, the whole point: good front/back coverage and nothing tagged
  // Detail is READY. If this ever goes back to blocking, sellers lose grades
  // they have the photos for.
  const got = gradingReadinessBlockers({
    garment_type: "jeans",
    garment_category: "denim",
    title: "Levi 501",
    photoTypes: ["front", "back", "label", "defect"],
  });
  assertEquals(got.blockers, []);
  assertEquals(got.warnings.length, 1);
});

Deno.test("edge: blocker strings are the exact user-facing copy", () => {
  // The web card regex-matches these (onlyGarmentBlocks), so they are a
  // cross-project contract, not just messages.
  const got = gradingReadinessBlockers({
    garment_type: null,
    garment_category: null,
    title: null,
    photoTypes: [],
  });
  assertEquals(got.blockers[0], "Missing garment_type");
  assertEquals(got.blockers[1], "Missing garment_category");
  assertEquals(got.blockers[2], "Missing title");
  assertEquals(got.blockers[3], "Missing required photos: front, back");
});
