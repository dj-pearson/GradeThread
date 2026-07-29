// US-2238: the URL-fed sourcing appraisal (/api/flipdesk/scout/appraise-url).
//
// The generic URL-validation cases live in extension-image-urls_test.ts, which
// imports the shared parser directly and so runs with no network. What is left
// here is the part that is genuinely THIS route's: its own error copy, its cap
// choice, and the US-620 disclaimer wording. Those need the route module, so this
// file only runs where hono/supabase resolve (CI).
//
// Prime env then dynamic-import (the route pulls in supabase.ts via quick-grade).
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key");
Deno.env.set("ANTHROPIC_API_KEY", Deno.env.get("ANTHROPIC_API_KEY") ?? "test-key");

const { parseAppraiseUrls, APPRAISE_URL_DISCLAIMER } = await import(
  "../routes/flipdesk-scout.ts"
);

Deno.test("parseAppraiseUrls: caps at the anonymous ceiling, not the paid one", () => {
  // A sourcing appraisal's value comes from the comps, not from a deeper
  // condition read, so it does not buy the 8-photo tier.
  const r = parseAppraiseUrls(Array.from({ length: 10 }, (_, i) => `https://i.ebayimg.com/${i}.jpg`));
  assert(r.ok);
  assertEquals(r.urls.length, 4);
});

Deno.test("parseAppraiseUrls: error copy names LISTING photos, not 'images'", () => {
  // The seller is looking at somebody else's listing, so the generic buyer copy
  // ("Each image must be a valid URL") would read as being about their upload.
  const bad = parseAppraiseUrls(["not a url"]);
  assertEquals(bad.ok, false);
  if (!bad.ok) assert(/listing photo/i.test(bad.error));

  const empty = parseAppraiseUrls([]);
  assertEquals(empty.ok, false);
  if (!empty.ok) assert(/listing photo/i.test(empty.error));
});

Deno.test("the disclaimer states it is private and not a certificate (US-620)", () => {
  assert(/private/i.test(APPRAISE_URL_DISCLAIMER));
  assert(/not a GradeThread certificate/i.test(APPRAISE_URL_DISCLAIMER));
  assert(
    /never shown to the seller/i.test(APPRAISE_URL_DISCLAIMER),
    "a shadow grade must never be presented as something the listing's seller sees",
  );
});
