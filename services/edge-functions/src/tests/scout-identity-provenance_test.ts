// US-2763: a brand eBay guessed from pixels is not a brand the seller can price
// against.
//
// THE ASYMMETRY THIS FIXES. hintsProvider already refused to prefill from a
// keyword hit, with the reason written in the file: "a keyword's top hit is
// somebody else's listing title". ebayImageProvider took items[0].title
// unconditionally — from a PURE similarity match, which is strictly weaker
// evidence than a keyword the seller typed. The provider with less to go on was
// the more assertive one.
//
// The spike measured what that costs: a teal athletic tank with no brand mark
// anywhere in the frame returned five Lululemon tanks, with no expressed doubt.
// It may be right. The photo cannot say. And a wrong brand does not merely
// mislabel the item, it prices it against the wrong comps.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { createHintsProvider, createEbayImageProvider, identifyWithFallback } = await import(
  "../lib/scout-identify.ts"
);

// ES modules are immutable, so the comp lookup is injected rather than patched.
// createHintsProvider exists for exactly this: the barcode-vs-keyword
// distinction cannot otherwise be exercised without reaching Supabase and eBay.
const hintsWith = (result: unknown) =>
  createHintsProvider(() => Promise.resolve({ result, hit: false }) as never);

const FAKE_COMPS = {
  items: [{ title: "Lululemon Womens Tank Top Sleeveless Blue" }],
  stats: { count: 5, currency: "USD" },
} as never;

function baseReq(over: Record<string, unknown> = {}) {
  return {
    imageDataUri: "data:image/jpeg;base64,AAAA",
    imageRole: "front",
    barcode: "",
    q: "blue tank",
    brand: "",
    categoryId: "57988",
    size: "",
    ...over,
  };
}

// ── 1. The hints provider: only a barcode is authoritative ───────────────────

Deno.test("a barcode match is authoritative and says so", async () => {
  const out = await hintsWith(FAKE_COMPS)
    .identify(baseReq({ barcode: "0123456789012" }), "3000");
  assert(out);
  assertEquals(out.identitySource, "barcode");
  assertEquals(out.identityIsAuthoritative, true);
  assert(out.matchedTitle, "a barcode match should carry a title");
});

Deno.test("a keyword match names nothing and claims nothing", async () => {
  const out = await hintsWith(FAKE_COMPS).identify(baseReq(), "3000");
  assert(out);
  assertEquals(out.matchedTitle, null, "a keyword's top hit is somebody else's listing");
  assertEquals(out.identitySource, null);
  assertEquals(out.identityIsAuthoritative, false);
});

// ── 2. AC6: a visual match can never be written as fact ──────────────────────

Deno.test("a visual match is NEVER authoritative, however good it looks", async () => {
  // The exact spike case, driven for real: a coherent, confident, five-of-five
  // answer for a garment carrying no brand mark anywhere in the frame.
  const provider = createEbayImageProvider(() =>
    Promise.resolve({
      items: [{ title: "Lululemon Womens Tank Top Sleeveless Blue" }],
      stats: { count: 5, currency: "USD" },
    }) as never
  );

  const out = await provider.identify(baseReq(), "3000");
  assert(out, "the provider declined a front-role photo with a good match");
  assertEquals(out.matchedTitle, "Lululemon Womens Tank Top Sleeveless Blue");
  assertEquals(out.identitySource, "visual");
  assertEquals(
    out.identityIsAuthoritative,
    false,
    "a similarity match claimed authority; this is the one that prices a no-name " +
      "tank against Lululemon comps",
  );
});

Deno.test("even a single unambiguous-looking hit stays non-authoritative", async () => {
  const provider = createEbayImageProvider(() =>
    Promise.resolve({
      items: [{ title: "Faherty Reserve Mens Movement Polo Shirt Medium" }],
      stats: { count: 1, currency: "USD" },
    }) as never
  );
  const out = await provider.identify(baseReq(), "3000");
  assert(out);
  assertEquals(out.identityIsAuthoritative, false, "confidence is not provenance");
});

Deno.test("the SOURCE of ebayImageProvider hard-codes non-authoritative", async () => {
  // A source-level guard, because the runtime branch above needs a network the
  // test cannot reach. This is the assertion that actually holds the contract:
  // it fails the moment someone flips the literal.
  const src = await Deno.readTextFile(
    new URL("../lib/scout-identify.ts", import.meta.url),
  );
  const start = src.indexOf('name: "ebay-image"');
  assert(start > -1, "ebayImageProvider not found");
  const body = src.slice(start);
  const authLine = /identityIsAuthoritative:\s*(\w+)/.exec(body);
  assert(authLine, "ebayImageProvider sets no identityIsAuthoritative");
  assertEquals(
    authLine[1],
    "false",
    "ebayImageProvider now claims an authoritative identity from a similarity match",
  );
  assert(
    /identitySource:\s*"visual"/.test(body),
    "ebayImageProvider no longer labels its identity as visual",
  );
});

// ── 3. The flag the client reads travels with the title ──────────────────────

Deno.test("every outcome carries provenance, so a caller cannot forget to ask", async () => {
  const stub = {
    name: "hints" as const,
    identify: () =>
      Promise.resolve({
        comps: FAKE_COMPS,
        matchedTitle: "something",
        identitySource: "visual" as const,
        identityIsAuthoritative: false,
        provider: "hints" as const,
      }),
  };
  const out = await identifyWithFallback([stub], baseReq(), "3000");
  assert(out);
  assert(
    "identityIsAuthoritative" in out && "identitySource" in out,
    "the outcome lost its provenance passing through identifyWithFallback",
  );
});

// ── 4. The route must not send a title without its provenance ────────────────

Deno.test("the appraise response ships identitySource beside matchedTitle", async () => {
  const src = await Deno.readTextFile(
    new URL("../routes/flipdesk-scout.ts", import.meta.url),
  );
  // Both fields, in the response object, not merely computed and dropped.
  assert(
    /matchedTitle,\s*(?:\/\/[^\n]*\n\s*)*identitySource,/.test(src),
    "identitySource is not sent next to matchedTitle in the appraise response — " +
      "a client receiving the title with no provenance has no way to tell a " +
      "barcode match from a look-alike",
  );
  assert(
    /identityIsAuthoritative,/.test(src),
    "identityIsAuthoritative is not in the appraise response",
  );
});
