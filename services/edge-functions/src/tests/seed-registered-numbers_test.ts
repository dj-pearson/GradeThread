// US-9034: the seeder drains the queue it reads.
//
// The bug this guards is invisible from the outside. A seeder run that
// re-searches numbers the registry already answers produces exactly the same
// registry as one that skips them — it just spends two seconds of the FTC's
// public service per pointless lookup, and it gets slower every time somebody
// photographs a tag. Nothing in the output says so, which is why it survived
// from 00501 until now.
//
//   deno test --allow-read src/tests/seed-registered-numbers_test.ts

// Loads the test env before anything can reach lib/supabase.ts at import
// time (US-2379); without it this file only passes when another ran first.
import "./_env.ts";
import { assertEquals } from "@std/assert";
import { sightingCandidatesFrom } from "../../scripts/seed-registered-numbers.ts";

const rows = [
  { registry_key: "RN:56323" },
  { registry_key: "RN:99999" },
  { registry_key: "CA:32054" },
];

Deno.test("a number the registry already answers is never searched again", () => {
  const known = new Set(["RN:56323"]);
  assertEquals(
    sightingCandidatesFrom(rows, known).map((c) => c.term),
    ["99999", "32054"],
  );
});

Deno.test("an empty registry searches every queued number", () => {
  assertEquals(
    sightingCandidatesFrom(rows, new Set()).map((c) => c.term),
    ["56323", "99999", "32054"],
  );
});

Deno.test("CA numbers are searched too — the sitemap asymmetry is not this one", () => {
  // /rn/:number renders and indexes a CA page; only sitemap-rn.xml leaves it
  // out. Dropping CA here would starve a page we do serve.
  const terms = sightingCandidatesFrom([{ registry_key: "CA:32054" }], new Set());
  assertEquals(terms.map((c) => c.term), ["32054"]);
  assertEquals(terms[0].origin, "sighting");
});

Deno.test("a malformed key is dropped rather than searched as an empty term", () => {
  // An empty search term would return the whole register's first page and
  // decideSeedRow would file it as REVIEW, which is noise an operator then has
  // to read past.
  assertEquals(
    sightingCandidatesFrom(
      [{ registry_key: "RN:" }, { registry_key: "" }, { registry_key: "nonsense" }],
      new Set(),
    ),
    [],
  );
});

Deno.test("a duplicate queue row is searched once", () => {
  assertEquals(
    sightingCandidatesFrom(
      [{ registry_key: "RN:7" }, { registry_key: "RN:7" }],
      new Set(),
    ).map((c) => c.term),
    ["7"],
  );
});

Deno.test("candidates carry no brand keys, so a seeded row claims no brand", () => {
  // A sighting knows a number, not whose it is. Writing brand_keys off a
  // declared brand would put a seller's guess under our provenance.
  for (const c of sightingCandidatesFrom(rows, new Set())) {
    assertEquals(c.brandKeys, []);
  }
});
