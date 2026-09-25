// MC-05: the measurement-stats read path looks up the department the ingest
// filed the rows under, never one derived from a gender query param.
//
//   deno test --allow-env --allow-read src/tests/measurement-stats_test.ts

import { assert, assertEquals } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { measurementStatsDepartment } = await import(
  "../routes/flipdesk-measurement-stats.ts"
);
const { resolveMeasurementCohort } = await import(
  "../lib/measurement-ingest.ts"
);

const ROUTE = await Deno.readTextFile(
  new URL("../routes/flipdesk-measurement-stats.ts", import.meta.url),
);

const STYLES = [
  {
    styleName: "501",
    aliases: ["501 original"],
    productLine: null,
    department: "Men",
    category: "jeans",
    visualFingerprint: null,
    fabricTech: [],
    era: null,
    msrpBand: null,
    keywords: [],
  },
];

Deno.test("MC-05: an unmatched style reads the brand rollup under '' (as ingested)", () => {
  const cohort = resolveMeasurementCohort({
    brand: "Levi's",
    style: "some style nobody knows",
    size: "34x32",
    group: "bottom",
    styles: STYLES,
  });
  assert(cohort);
  assertEquals(cohort.styleKey, "");
  // The write path filed it under ''; gender=Men must not move the read.
  assertEquals(cohort.department, "");
  assertEquals(measurementStatsDepartment(cohort), "");
});

Deno.test("MC-05: a matched style reads under the style's own department", () => {
  const cohort = resolveMeasurementCohort({
    brand: "Levi's",
    style: "501",
    size: "34x32",
    group: "bottom",
    styles: STYLES,
  });
  assert(cohort);
  assertEquals(measurementStatsDepartment(cohort), cohort.department);
  assertEquals(cohort.department, "Men");
});

Deno.test("MC-05: the route no longer reads a gender param", () => {
  assert(!ROUTE.includes('normalizeDepartment(c.req.query("gender"))'));
  assert(!ROUTE.includes('c.req.query("gender")'));
  assert(ROUTE.includes("measurementStatsDepartment(cohort)"));
});
