// US-2762: visual search must not be handed a ruler shot.
//
// WHAT THE SPIKE FOUND. eBay's search_by_image does not degrade gracefully on a
// photo that is not of a garment — it answers the question the photo asks. A
// care label returned a midi dress and joggers. A tape measure across a hem
// returned mens dress pants. A defect macro of red fabric returned red fabric
// sold by the yard. All three with the same confidence as the whole-garment
// shots that got the brand right 5/5.
//
// So there is nothing in the RESPONSE to filter on. The decision has to happen
// on the input, before the call.
//
// AC5 IS SPECIFIC ABOUT WHAT TO ASSERT: that the eBay client is never CALLED,
// not that its result was discarded. A provider that calls and throws the answer
// away still burns the ~1s round trip this story exists to save, and would pass
// a test written against the return value.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  IDENTIFYING_PHOTO_ROLES,
  roleCanIdentify,
  ebayImageProvider,
  identifyWithFallback,
} = await import("../lib/scout-identify.ts");

const DATA_URI = "data:image/jpeg;base64,AAAA";

function req(role: string | null | undefined) {
  return {
    imageDataUri: DATA_URI,
    imageRole: role,
    barcode: "",
    q: "carhartt jacket",
    brand: "",
    categoryId: "57988",
    size: "",
  };
}

// ── 1. The roles the measurement said work, and the ones it said do not ──────

Deno.test("roles measured as identifying are allowed", () => {
  for (const role of ["front", "back", "flatlay", "label", "tag"]) {
    assert(roleCanIdentify(role), `${role} should be able to identify`);
  }
});

Deno.test("roles measured as returning nonsense are refused", () => {
  // Each of these is a real spike result, not a guess.
  for (const role of ["detail", "defect", "measurement"]) {
    assert(!roleCanIdentify(role), `${role} must not reach visual search`);
  }
});

Deno.test("an unknown or absent role is refused, not permitted (AC6)", () => {
  for (const role of [undefined, null, "", "  ", "hero", "closeup", "unknown"]) {
    assert(
      !roleCanIdentify(role as string | null | undefined),
      `${JSON.stringify(role)} was treated as permission; an unlabelled photo is ` +
        `likelier to be a detail shot than a flatlay`,
    );
  }
});

Deno.test("the role is read case- and whitespace-insensitively", () => {
  // iOS and the web send these from different places; a capitalised "Front"
  // silently disabling the feature would be a bug nobody could see.
  assert(roleCanIdentify("Front"));
  assert(roleCanIdentify("  FRONT  "));
  assert(!roleCanIdentify("Detail"));
});

// ── 2. AC5: the eBay client is not CALLED for a non-identifying role ─────────

Deno.test("a detail-role request never calls the eBay image search at all", async () => {
  let calls = 0;
  const spy = {
    name: "ebay-image" as const,
    identify: ebayImageProvider.identify,
  };
  // Stand in for the network boundary. If the provider reaches it, this counts.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((..._args: unknown[]) => {
    calls++;
    return Promise.reject(new Error("the network must not be reached"));
  }) as typeof fetch;

  try {
    const out = await spy.identify(req("detail"), "3000");
    assertEquals(out, null, "a detail shot must be declined, not answered");
    assertEquals(calls, 0, "the provider reached the network for a detail shot");

    const out2 = await spy.identify(req(undefined), "3000");
    assertEquals(out2, null);
    assertEquals(calls, 0, "the provider reached the network for an unlabelled photo");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("a front-role request DOES reach the eBay image search", async () => {
  // The other half of AC5. Without this the gate could refuse everything and
  // every test above would still pass.
  let reached = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((..._args: unknown[]) => {
    reached = true;
    return Promise.reject(new Error("stop here; reaching the boundary is the assertion"));
  }) as typeof fetch;

  try {
    await ebayImageProvider.identify(req("front"), "3000").catch(() => null);
    assert(reached, "a front shot was declined; the gate is refusing everything");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── 3. Declining is free, and lands on hints ─────────────────────────────────

Deno.test("declining falls straight through to hints without spending the timeout", async () => {
  let imageCalls = 0;
  const image = {
    name: "ebay-image" as const,
    identify: (r: typeof req extends (x: never) => infer _ ? never : Parameters<typeof ebayImageProvider.identify>[0], c: string) => {
      imageCalls++;
      return ebayImageProvider.identify(r, c);
    },
  };
  const hints = {
    name: "hints" as const,
    identify: () =>
      Promise.resolve({
        comps: { items: [], stats: { count: 0 } } as never,
        matchedTitle: null,
        provider: "hints" as const,
      }),
  };

  const started = Date.now();
  const out = await identifyWithFallback(
    [image, hints],
    req("measurement"),
    "3000",
    { timeoutMs: 1500 },
  );
  const elapsed = Date.now() - started;

  assertEquals(imageCalls, 1, "the image provider should still be consulted");
  assertEquals(out?.provider, "hints", "the fallback did not land on hints");
  assert(
    elapsed < 300,
    `declining took ${elapsed}ms — it should be immediate, not the ${1500}ms timeout`,
  );
});

// ── 4. The allowlist cannot quietly grow a role the spike disproved ──────────

Deno.test("the identifying-role set stays the measured one", () => {
  const got = [...IDENTIFYING_PHOTO_ROLES].sort();
  assertEquals(
    got,
    ["back", "flatlay", "front", "label", "tag"],
    "IDENTIFYING_PHOTO_ROLES changed. Each entry is a measured result from " +
      "US-2758, so adding one needs a measurement, not an opinion.",
  );
  for (const banned of ["detail", "defect", "measurement"]) {
    assert(
      !IDENTIFYING_PHOTO_ROLES.has(banned),
      `${banned} was added to the identifying roles; the spike measured it ` +
        `returning confident nonsense`,
    );
  }
});
