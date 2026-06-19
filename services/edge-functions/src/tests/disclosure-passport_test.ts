// US-1095: the listing disclosure carries a Garment Passport link when the
// grade's garment has a passport, so a relisted item's history continues across
// platforms (the next buyer can open the chain and claim the item). Pure
// function — no DB, no env.

import { assert } from "@std/assert";
import { buildDisclosure, type DisclosureInput } from "../lib/disclosure.ts";

const BASE: DisclosureInput = {
  overall_score: 8.5,
  grade_tier: "Excellent",
  defects_found: [],
  certificate_id: "CERT-ABC",
  siteUrl: "https://gradethread.com",
};

Deno.test("disclosure includes the passport link in every rendering when slug is set", () => {
  const d = buildDisclosure({ ...BASE, passport_slug: "slug123" });
  const url = "https://gradethread.com/passport/slug123";
  assert(d.plain.includes(url), "plain text carries the passport URL");
  assert(d.markdown.includes(url), "markdown carries the passport URL");
  assert(d.html.includes(url), "html carries the passport URL");
  // The cert link is still present (the two are complementary).
  assert(d.plain.includes("https://gradethread.com/cert/CERT-ABC"));
});

Deno.test("disclosure omits the passport link when there is no slug", () => {
  const d = buildDisclosure({ ...BASE, passport_slug: null });
  assert(!d.plain.includes("/passport/"));
  assert(!d.markdown.includes("/passport/"));
  assert(!d.html.includes("/passport/"));
});
