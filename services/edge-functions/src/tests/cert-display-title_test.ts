// US-2613: stripping the seller's condition claim out of OUR certificate title.
//
// The cases that matter are not "does it remove NWT". They are the ones where a
// careless implementation does damage: eating letters inside a brand name,
// leaving stranded punctuation, or emptying a title that was nothing but a
// claim and publishing a certificate for no garment.
import { assert, assertEquals } from "@std/assert";
import { certDisplayTitle, hasConditionClaim } from "../lib/cert-display-title.ts";

Deno.test("US-2613: the live case that filed this", () => {
  // Rendered on a public, indexed certificate as
  // "…Made in Italy NWT — Grade 9.2 (NWOT)": the seller says tags on, the grade
  // says tags off, both in the search snippet.
  assertEquals(
    certDisplayTitle("Chiara Boni La Petite Robe Camel Off-Shoulder Sheath Dress Made in Italy NWT"),
    "Chiara Boni La Petite Robe Camel Off-Shoulder Sheath Dress Made in Italy",
  );
});

Deno.test("US-2613: strips the abbreviations sellers actually use", () => {
  for (const claim of ["NWT", "NWOT", "BNWT", "BNWOT", "EUC", "VGUC", "GUC", "NIB", "deadstock"]) {
    const out = certDisplayTitle(`Levi's 501 Jeans ${claim}`);
    assertEquals(out, "Levi's 501 Jeans", `failed on ${claim}`);
  }
});

Deno.test("US-2613: strips the phrases too, longest first", () => {
  // "new with tags" contains "new"; consuming the short one first would leave
  // a dangling "with tags".
  assertEquals(certDisplayTitle("Nike Windbreaker new with tags"), "Nike Windbreaker");
  assertEquals(certDisplayTitle("Nike Windbreaker brand new with tags"), "Nike Windbreaker");
  assertEquals(certDisplayTitle("Nike Windbreaker new without tags"), "Nike Windbreaker");
  assertEquals(certDisplayTitle("Nike Windbreaker like-new"), "Nike Windbreaker");
  assertEquals(certDisplayTitle("Nike Windbreaker never worn"), "Nike Windbreaker");
  assertEquals(certDisplayTitle("Nike Windbreaker pre-owned"), "Nike Windbreaker");
});

Deno.test("US-2613: does NOT eat letters inside real words", () => {
  // The reason every pattern is word-bounded. A substring pass turns Gucci into
  // "Cci" and eats the "ds" in "Adidas" and the "nib" in a hypothetical brand.
  const safe = [
    "Gucci Marmont Shoulder Bag",
    "Adidas Sambas",
    "Deuce Brand Watch",
    "Guess Denim Jacket",
    "Newton Running Shoes",
    "Renewed Wool Coat",
  ];
  for (const title of safe) {
    assertEquals(certDisplayTitle(title), title, `mangled: ${title}`);
    assertEquals(hasConditionClaim(title), false, `false positive: ${title}`);
  }
});

Deno.test("US-2613: leaves no stranded punctuation", () => {
  assertEquals(certDisplayTitle("Coach Tabby Bag, NWT"), "Coach Tabby Bag");
  assertEquals(certDisplayTitle("Coach Tabby Bag — EUC"), "Coach Tabby Bag");
  assertEquals(certDisplayTitle("NWT Coach Tabby Bag"), "Coach Tabby Bag");
  assertEquals(certDisplayTitle("Coach · NWT · Tabby Bag"), "Coach · Tabby Bag");
});

Deno.test("US-2613: a title that is ONLY a claim keeps the seller's words", () => {
  // Stripping to empty would publish a certificate titled " — Grade 9.2
  // (NWOT)". Losing the garment is worse than the contradiction this fixes.
  assertEquals(certDisplayTitle("NWT"), "NWT");
  assertEquals(certDisplayTitle("  EUC  "), "EUC");
  assertEquals(certDisplayTitle("NWT!"), "NWT!");
});

Deno.test("US-2613: an empty or absent title does not throw", () => {
  assertEquals(certDisplayTitle(""), "");
  assertEquals(certDisplayTitle("   "), "");
});

Deno.test("US-2613: strips even when the claim AGREES with the grade", () => {
  // Deliberate. A rule that fires only on disagreement behaves differently at
  // 9.2 and 9.6 for the same listing, and an agreeing claim is still the
  // seller's unverified word sitting where our verified number goes.
  assert(hasConditionClaim("Chanel Flap Bag NWOT"));
  assertEquals(certDisplayTitle("Chanel Flap Bag NWOT"), "Chanel Flap Bag");
});

// ---------------------------------------------------------------------------
// The wiring, not just the helper. A correct stripper nobody calls is the
// failure mode this repo has shipped before (grading-reliability.ts sat
// half-wired for a whole story), and here it would be invisible: the page keeps
// rendering, just with the contradiction still in it.

Deno.test("US-2613: both surfaces are wired to the same helper", () => {
  const src = Deno.readTextFileSync(
    new URL("../routes/content-public.ts", import.meta.url),
  );
  assert(
    src.includes('import { certDisplayTitle } from "../lib/cert-display-title.ts"'),
    "content-public.ts must import the shared helper",
  );

  // 1. The SSR payload the Pages <title> and og:title read.
  assert(
    /display_title:\s*certDisplayTitle\(/.test(src),
    "the /certificates/:id payload must expose display_title",
  );
  // 2. The OG card, rendered on this service rather than in Pages.
  assert(
    /title:\s*certDisplayTitle\(sub\?\.title/.test(src),
    "CertImageData.title must be stripped too — the card is our surface",
  );
  // 3. And the verbatim seller title must SURVIVE somewhere in that payload,
  //    because the body shows what the seller wrote. A commit that replaced
  //    `title` instead of adding `display_title` would pass 1 and 2 and quietly
  //    rewrite the seller's listing on their own certificate.
  assert(
    /title:\s*submission\?\.title\s*\?\?\s*"Graded garment"/.test(src),
    "the payload must still carry the seller's title verbatim",
  );
});

Deno.test("US-2613: the Pages page falls back when the edge predates the field", () => {
  // The edge and Pages deploy separately, so a Pages build can be live against
  // an edge with no display_title. The fallback is the seller's title unchanged
  // — visibly the old behaviour rather than an empty headline.
  const page = Deno.readTextFileSync(
    new URL("../../../../functions/cert/[id].ts", import.meta.url),
  );
  assert(
    /cert\.display_title\s*\?\?\s*cert\.title/.test(page),
    "functions/cert/[id].ts must fall back to cert.title",
  );
});
