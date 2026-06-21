// US-1126: the verified-seller credential block embedded in listing descriptions.
// Pure renderer — no DB, no env.

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

Deno.test("credential block carries handle link + stats in every rendering", () => {
  const b = buildSellerCredentialBlock(BASE, "https://gradethread.com");
  const url = "https://gradethread.com/verified/fadedglory";
  for (const text of [b.plain, b.markdown, b.html]) {
    assert(text.includes(url), "carries the profile URL");
    assert(text.includes("Faded Glory Vintage"), "carries the display name");
    assert(text.includes("8.3"), "carries the average grade");
    assert(text.includes("42"), "carries the graded count");
  }
});

Deno.test("credential block omits the stats line when no grades yet", () => {
  const b = buildSellerCredentialBlock({
    ...BASE,
    stats: { total_graded: 0, average_grade: 0 },
  });
  // Badge + link still present...
  assert(b.plain.includes("/verified/fadedglory"));
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

Deno.test("default site url when none supplied", () => {
  const b = buildSellerCredentialBlock(BASE);
  assertEquals(
    b.plain.includes("https://gradethread.com/verified/fadedglory"),
    true,
  );
});
