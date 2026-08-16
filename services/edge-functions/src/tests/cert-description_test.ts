// US-2628: the public certificate's "About this item" description.
//
// The bug this locks down: a submission description is usually the LISTING
// description, so it is HTML — and both certificate renderers print it as
// escaped text. A real certificate showed
// `<!--gradethread-seller-credentials--><div style="border:1px solid #e5e7eb...`
// as body copy. Pure renderer — no DB, no env.

import { assert, assertEquals } from "@std/assert";
import {
  certDescriptionText,
  DISCLOSURE_MARKER,
  htmlToPlainText,
} from "../lib/cert-description.ts";
import {
  buildSellerCredentialBlock,
  SELLER_CREDENTIALS_MARKER,
} from "../lib/seller-credentials.ts";

/** The shape that shipped on cert 9e8793a1, trimmed. */
const REAL_DESCRIPTION =
  `Chiara Boni La Petite Robe sheath dress in a rich camel/tan hue. - Brand: Chiara Boni ` +
  `- Condition: New with tags, never worn Smoke-free home. ` +
  SELLER_CREDENTIALS_MARKER +
  `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;font:14px/1.5 system-ui,sans-serif">` +
  `<div style="font-weight:700;color:#0F3460;margin-bottom:6px">GradeThread Verified Seller &mdash; Pearson Mercantile</div>` +
  `<div style="margin-bottom:8px">21 items independently graded &middot; <strong>8.2 / 10</strong> average condition grade</div>` +
  `<div style="color:#0F3460;font-weight:600">Verify grades at GradeThread &mdash; seller &quot;pearson&quot;</div>` +
  `</div>`;

Deno.test("the shipped certificate description loses every tag and the credential block", () => {
  const out = certDescriptionText(REAL_DESCRIPTION);
  assert(out, "still has readable copy");
  assert(!out.includes("<"), "no angle bracket survives");
  assert(!out.includes("style="), "no inline CSS survives");
  assert(!out.includes("#e5e7eb"), "no color literal survives");
  assert(!out.includes(SELLER_CREDENTIALS_MARKER), "marker comment is gone");
  assert(
    !out.includes("GradeThread Verified Seller"),
    "the generated block is dropped, not flattened — the page renders seller_integrity itself",
  );
  assert(out.includes("Chiara Boni"), "the seller's own copy is untouched");
  assert(out.includes("Smoke-free home."), "and reaches the end of their copy");
});

Deno.test("the disclosure block is dropped the same way", () => {
  const raw = `Body copy.\n${DISCLOSURE_MARKER}<div style="x"><div>Defects: light pilling</div></div>`;
  assertEquals(certDescriptionText(raw), "Body copy.");
});

Deno.test("a marker whose block was edited away only loses the marker", () => {
  // An eBay-side edit can strip the <div> and leave the comment. The copy
  // around it is the seller's, so it must survive verbatim.
  const raw = `Before. ${SELLER_CREDENTIALS_MARKER} After.`;
  assertEquals(certDescriptionText(raw), "Before. After.");
});

Deno.test("copy that follows the credential block survives", () => {
  // applyGradeListingPromotion appends the grade line AFTER the block, so
  // "everything from the marker on" would swallow it.
  const block = buildSellerCredentialBlock({
    handle: "pearson",
    display_name: "Pearson Mercantile",
    stats: { total_graded: 21, average_grade: 8.2 },
  });
  const raw = `Body.\n${SELLER_CREDENTIALS_MARKER}${block.html}\n\nGraded by GradeThread - Condition Grade 7.9 - Cert #GT-X9RQ0J6`;
  const out = certDescriptionText(raw);
  assert(out, "has output");
  assert(!out.includes("Pearson Mercantile"), "block gone");
  assertEquals(
    out,
    "Body.\n\nGraded by GradeThread - Condition Grade 7.9 - Cert #GT-X9RQ0J6",
  );
});

Deno.test("block tags become line breaks, so paragraphs and bullets survive", () => {
  const raw =
    `<p>Great dress.</p><p>Measurements:</p><ul><li>Chest 20"</li><li>Length 38"</li></ul>` +
    `Ships fast.<br>Thanks!`;
  assertEquals(
    htmlToPlainText(raw),
    // One break per tag: <p>...</p> pairs give a blank line, a lone closing
    // tag before bare text gives a single one.
    'Great dress.\n\nMeasurements:\n\n- Chest 20"\n- Length 38"\nShips fast.\nThanks!',
  );
});

Deno.test("script and style contents never print as body copy", () => {
  const raw = `<style>.x{color:red}</style>Real copy.<script>alert(1)</script>`;
  assertEquals(htmlToPlainText(raw), "Real copy.");
});

Deno.test("entities are decoded, not left as source", () => {
  assertEquals(
    htmlToPlainText(`Ralph &amp; Co &quot;NWT&quot; &lt;new&gt; &#39;mint&#39;`),
    `Ralph & Co "NWT" <new> 'mint'`,
  );
});

Deno.test("an entity that decodes to a tag does NOT re-open the stripper", () => {
  // Single-pass decoding: &lt;script&gt; must stay visible text, never become
  // markup that a second strip pass would act on.
  const out = htmlToPlainText(`&lt;script&gt;alert(1)&lt;/script&gt;`);
  assertEquals(out, "<script>alert(1)</script>");
});

Deno.test("invisible and bidi characters are removed, exotic spaces normalized", () => {
  const zwsp = String.fromCharCode(0x200b);
  const rlo = String.fromCharCode(0x202e);
  const nbsp = String.fromCharCode(0x00a0);
  const bom = String.fromCharCode(0xfeff);
  const out = htmlToPlainText(`A${zwsp}B${rlo}C${nbsp}D${bom}`);
  assertEquals(out, "ABC D");
});

Deno.test("null, empty and markup-only descriptions yield null", () => {
  assertEquals(certDescriptionText(null), null);
  assertEquals(certDescriptionText(undefined), null);
  assertEquals(certDescriptionText("   "), null);
  assertEquals(certDescriptionText("<div><br></div>"), null);
  assertEquals(
    certDescriptionText(`${SELLER_CREDENTIALS_MARKER}<div>only the block</div>`),
    null,
  );
});

Deno.test("plain text passes through unchanged", () => {
  const raw = "Vintage Levi's 501, size 34. No flaws. Ships next day.";
  assertEquals(certDescriptionText(raw), raw);
});

// ---------------------------------------------------------------------------
// The wiring, not just the helper. A flattener nobody calls looks exactly like
// the bug it fixes, and both certificate surfaces read this one field.

Deno.test("US-2628: the public cert payload is wired to the flattener", () => {
  const src = Deno.readTextFileSync(
    new URL("../routes/content-public.ts", import.meta.url),
  );
  assert(
    src.includes('import { certDescriptionText } from "../lib/cert-description.ts"'),
    "content-public.ts must import the shared flattener",
  );
  assert(
    /description:\s*certDescriptionText\(submission\?\.description\)/.test(src),
    "the /certificates/:id payload must flatten the description, not pass it through",
  );
});

Deno.test("US-2628: the SSR page still escapes, and keeps the line breaks", () => {
  const page = Deno.readTextFileSync(
    new URL("../../../../functions/cert/[id].ts", import.meta.url),
  );
  assert(
    /escape\(cert\.description\)\.replace\(\/\\n\/g,\s*"<br>"\)/.test(page),
    "functions/cert/[id].ts must escape first and only then turn newlines into <br>",
  );
  assert(
    !/\$\{cert\.description\}/.test(page),
    "the description must NEVER be interpolated raw — it is seller-controlled",
  );
});
