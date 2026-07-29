// US-1880 (AC3): selector-failure telemetry validation (pure). No DB.
//
// THE POINT OF THESE TESTS. The privacy promise on this endpoint — "no listing
// URL, no account, nothing joinable to a person" — is not enforceable by
// reviewing the extension, because the extension is client code that a user (or
// an attacker who has modified it) fully controls. The server has to be the
// thing that refuses to store a URL. So the interesting cases below are all
// hostile-client cases, not happy-path shape checks.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key");

const { parseSelectorHealth } = await import("../routes/public-grading.ts");

// ── happy path ──────────────────────────────────────────────────────────────

Deno.test("selector-health: accepts a well-formed ping", () => {
  const out = parseSelectorHealth({
    adapter: "poshmark",
    emptySelectors: ["gallery", "brand"],
    configVersion: "2026.07.5",
    extVersion: "0.3.5",
  });
  assertEquals(out?.adapter, "poshmark");
  assertEquals(out?.emptySelectors, ["gallery", "brand"]);
  assertEquals(out?.configVersion, "2026.07.5");
  assertEquals(out?.extVersion, "0.3.5");
});

Deno.test("selector-health: distinguishes the two gallery failure modes", () => {
  // 'gallery' = no selector matched anything (gallery selectors are wrong).
  // 'gallery-no-urls' = elements matched but yielded no usable URL (imageAttrs
  // or the urlUpgrade rule is wrong — the dead Poshmark regex was this kind).
  // Collapsing them would throw away which half to go fix.
  assertEquals(
    parseSelectorHealth({ adapter: "poshmark", emptySelectors: ["gallery-no-urls"] })?.emptySelectors,
    ["gallery-no-urls"],
  );
});

Deno.test("selector-health: normalizes adapter case and dedupes", () => {
  const out = parseSelectorHealth({
    adapter: "  EBAY ",
    emptySelectors: ["gallery", "gallery", "title"],
  });
  assertEquals(out?.adapter, "ebay");
  assertEquals(out?.emptySelectors, ["gallery", "title"]);
});

// ── the closed vocabulary is the privacy boundary ───────────────────────────

Deno.test("selector-health: a URL cannot be smuggled through any field", () => {
  const url = "https://poshmark.com/listing/some-jacket-64f0a1b2c3";

  // ...not as a selector name (closed vocabulary → filtered, leaving nothing).
  assertEquals(parseSelectorHealth({ adapter: "poshmark", emptySelectors: [url] }), null);

  // ...not mixed in alongside a valid one (the URL is dropped, not stored).
  assertEquals(
    parseSelectorHealth({ adapter: "poshmark", emptySelectors: ["gallery", url] })?.emptySelectors,
    ["gallery"],
  );

  // ...not as a version string (charset excludes : and /).
  const v = parseSelectorHealth({ adapter: "poshmark", emptySelectors: ["gallery"], configVersion: url });
  assertEquals(v?.configVersion, null);

  // ...and not as the adapter key itself.
  assertEquals(parseSelectorHealth({ adapter: url, emptySelectors: ["gallery"] }), null);
});

Deno.test("selector-health: rejects unknown adapter keys", () => {
  // A closed list is deliberate: an open one would accept an arbitrary
  // attacker-chosen string into a stored column.
  assertEquals(parseSelectorHealth({ adapter: "etsy", emptySelectors: ["gallery"] }), null);
  assertEquals(parseSelectorHealth({ adapter: "", emptySelectors: ["gallery"] }), null);
});

Deno.test("selector-health: every shipped adapter key is accepted", async () => {
  // Derived from the shipped config, NOT a hardcoded list — a restated list
  // could not catch the drift it exists to catch. If a new marketplace adapter
  // ships without being added to the server's allowlist, its telemetry is
  // silently dropped, and the failure mode is the worst possible one: the new
  // marketplace looks perfectly healthy precisely because it is broken.
  const cfgUrl = new URL("../../../../public/extension/marketplace-selectors.json", import.meta.url);
  const cfg = JSON.parse(await Deno.readTextFile(cfgUrl)) as { adapters: Record<string, unknown> };
  const keys = Object.keys(cfg.adapters);
  assert(keys.length > 0, "config has no adapters — wrong path?");
  for (const key of keys) {
    assert(
      parseSelectorHealth({ adapter: key, emptySelectors: ["gallery"] }) !== null,
      `adapter "${key}" ships in marketplace-selectors.json but /selector-health rejects it — ` +
        "add it to SELECTOR_HEALTH_ADAPTERS, or its breakage reports vanish silently",
    );
  }
});

Deno.test("selector-health: caps version strings", () => {
  const long = "x".repeat(33);
  assertEquals(
    parseSelectorHealth({ adapter: "ebay", emptySelectors: ["gallery"], extVersion: long })?.extVersion,
    null,
  );
  assertEquals(
    parseSelectorHealth({ adapter: "ebay", emptySelectors: ["gallery"], extVersion: "x".repeat(32) })?.extVersion,
    "x".repeat(32),
  );
});

// ── signal-free pings are rejected ──────────────────────────────────────────

Deno.test("selector-health: rejects a ping carrying no signal", () => {
  assertEquals(parseSelectorHealth({ adapter: "ebay", emptySelectors: [] }), null);
  assertEquals(parseSelectorHealth({ adapter: "ebay" }), null);
  assertEquals(parseSelectorHealth({ adapter: "ebay", emptySelectors: ["nonsense"] }), null);
});

Deno.test("selector-health: rejects junk bodies without throwing", () => {
  for (const body of [null, undefined, "", 0, [], "gallery", { emptySelectors: ["gallery"] }]) {
    assertEquals(parseSelectorHealth(body), null);
  }
  // Non-string members must not crash the filter.
  assertEquals(
    parseSelectorHealth({ adapter: "ebay", emptySelectors: [1, null, {}, "gallery"] })?.emptySelectors,
    ["gallery"],
  );
});

// ── US-2237 / US-2239: the newer, quieter surfaces ──────────────────────────
//
// A broken search grid and an unresolvable seller both fail SILENTLY by design —
// the shopper never asked for a scan, and a missing seller line is
// indistinguishable from "you haven't read this seller twice". Neither would ever
// be user-reported, so the closed vocabulary has to carry them or the pings the
// content script sends are dropped on the floor and the feature looks fine while
// it is dead.
Deno.test("selector-health: accepts the scan + seller signals", () => {
  assertEquals(
    parseSelectorHealth({ adapter: "vinted", emptySelectors: ["search-cards"] })?.emptySelectors,
    ["search-cards"],
  );
  assertEquals(
    parseSelectorHealth({ adapter: "grailed", emptySelectors: ["seller"] })?.emptySelectors,
    ["seller"],
  );
});

Deno.test("selector-health: the vocabulary is still CLOSED", () => {
  // The point of the allowlist is that an unknown name carries no signal and
  // could smuggle free text into an unauthenticated write. Adding two names must
  // not have turned it into a passthrough.
  assertEquals(parseSelectorHealth({ adapter: "ebay", emptySelectors: ["whatever"] }), null);
  assertEquals(
    parseSelectorHealth({ adapter: "ebay", emptySelectors: ["https://evil.test/?u=1"] }),
    null,
  );
  // A known name alongside an unknown one keeps only the known one.
  assertEquals(
    parseSelectorHealth({ adapter: "ebay", emptySelectors: ["seller", "made-up"] })?.emptySelectors,
    ["seller"],
  );
});
