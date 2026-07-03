// US-1126: the verified-seller credential block embedded in listing descriptions.
// Pure renderer — no DB, no env.
//
// eBay-policy hardening: NO variant may carry a URL or an <a> tag. eBay hides
// listings whose description links off-eBay (observed policy hit, ref
// 2-106523659851), and the other marketplaces the plain variant reaches
// (Poshmark, Mercari) prohibit external links too. The trust signal is
// text-only: brand + handle + stats.

import { assert, assertEquals } from "@std/assert";
import {
  buildSellerCredentialBlock,
  type SellerCredential,
} from "../lib/seller-credentials.ts";

const BASE: SellerCredential = {
  handle: "fadedglory",
  display_name: "Faded Glory Vintage",
  stats: { total_graded: 42, average_grade: 8.3 },
};

Deno.test("credential block carries name + stats in every rendering", () => {
  const b = buildSellerCredentialBlock(BASE, "https://gradethread.com");
  for (const text of [b.plain, b.markdown, b.html]) {
    assert(text.includes("Faded Glory Vintage"), "carries the display name");
    assert(text.includes("8.3"), "carries the average grade");
    assert(text.includes("42"), "carries the graded count");
    assert(text.includes("fadedglory"), "carries the handle (searchable)");
  }
});

Deno.test("NO variant carries a URL or link — eBay hides off-eBay links", () => {
  const b = buildSellerCredentialBlock(BASE, "https://gradethread.com");
  for (const text of [b.plain, b.markdown, b.html]) {
    assert(!/https?:\/\//i.test(text), "no URL in any variant");
    assert(!text.includes("/verified/"), "no profile path in any variant");
  }
  assert(!/<a\b/i.test(b.html), "no anchor tag in the html variant");
  assert(!/\]\(/.test(b.markdown), "no markdown link");
});

Deno.test("credential block omits the stats line when no grades yet", () => {
  const b = buildSellerCredentialBlock({
    ...BASE,
    stats: { total_graded: 0, average_grade: 0 },
  });
  // Badge + verify pointer still present...
  assert(b.plain.includes("Verify grades at GradeThread"));
  assert(b.html.includes("Verified Seller"));
  // ...but no "0 items" / average line.
  assert(!b.plain.includes("independently graded"));
  assert(!b.html.includes("average condition grade"));
});

Deno.test("singular item label for exactly one grade", () => {
  const b = buildSellerCredentialBlock({
    ...BASE,
    stats: { total_graded: 1, average_grade: 9 },
  });
  assert(b.plain.includes("1 item independently graded"));
  assert(!b.plain.includes("1 items"));
});

Deno.test("falls back to handle when no display name", () => {
  const b = buildSellerCredentialBlock({ ...BASE, display_name: null });
  assert(b.plain.includes("fadedglory"));
});

Deno.test("html escapes the display name", () => {
  const b = buildSellerCredentialBlock({
    ...BASE,
    display_name: `Bob & "Co" <script>`,
  });
  assert(b.html.includes("Bob &amp; &quot;Co&quot; &lt;script&gt;"));
  assert(!b.html.includes("<script>"));
});

Deno.test("default site url param is accepted and still emits no link", () => {
  const b = buildSellerCredentialBlock(BASE);
  assertEquals(/https?:\/\//i.test(b.plain), false);
});
