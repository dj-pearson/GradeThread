// US-722: resolveMarketplaceCategory order — cache → seed → AI → unmapped.
// Pure logic exercised with injected I/O (no Supabase/Anthropic). Set dummy
// supabase env first because the module loads supabase/ai-config at init.
//   deno test --allow-env src/tests/marketplace-category-resolve_test.ts
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { resolveMarketplaceCategory } = await import(
  "../lib/marketplace-category-resolve.ts"
);

// Deps that never touch the network — record what saveCache is asked to write.
function deps(over: Record<string, unknown> = {}) {
  const saved: unknown[] = [];
  return {
    saved,
    loadCache: () => Promise.resolve(null),
    saveCache: (row: unknown) => {
      saved.push(row);
      return Promise.resolve();
    },
    aiSuggest: () => Promise.resolve(null),
    ...over,
  };
}

Deno.test("eBay/Shopify are never resolved via the no-API map", async () => {
  for (const p of ["ebay", "shopify"] as const) {
    const r = await resolveMarketplaceCategory(p, "tops", null, deps());
    assertEquals(r.status, "unmapped");
    assertEquals(r.source, "none");
  }
});

Deno.test("cache/admin override wins over seed", async () => {
  const d = deps({
    loadCache: () =>
      Promise.resolve({
        platform_category: "Custom Tees",
        department: "Men",
        source: "admin",
        needs_confirmation: false,
      }),
  });
  const r = await resolveMarketplaceCategory("poshmark", "tops", null, d);
  assertEquals(r.status, "mapped");
  assertEquals(r.path, "Custom Tees");
  assertEquals(r.source, "admin");
  assertEquals(r.department, "Men");
  // A cache hit must NOT re-write the cache.
  assertEquals(d.saved.length, 0);
});

Deno.test("seed resolves and writes through to the cache", async () => {
  const d = deps();
  const r = await resolveMarketplaceCategory("mercari", "outerwear", null, d);
  assertEquals(r.status, "mapped");
  assertEquals(r.path, "Coats & jackets");
  assertEquals(r.source, "seed");
  assertEquals(r.needsConfirmation, false);
  assertEquals(d.saved.length, 1);
  assertEquals((d.saved[0] as { source: string }).source, "seed");
});

Deno.test("unseeded garment falls to AI and caches with needs_confirmation", async () => {
  const d = deps({
    aiSuggest: () =>
      Promise.resolve({ path: "Swim", department: "Women", confidence: 0.8 }),
  });
  const r = await resolveMarketplaceCategory("poshmark", "swimsuit", "swimwear", d);
  assertEquals(r.status, "mapped");
  assertEquals(r.path, "Swim");
  assertEquals(r.source, "ai");
  assert(r.needsConfirmation);
  assertEquals(d.saved.length, 1);
  const row = d.saved[0] as { source: string; needs_confirmation: boolean; gradethread_garment: string };
  assertEquals(row.source, "ai");
  assert(row.needs_confirmation);
  // Keyed by the raw label (lowercased) when the garment type isn't canonical.
  assertEquals(row.gradethread_garment, "swimsuit");
});

Deno.test("AI declines → unmapped (seller picks a category)", async () => {
  const d = deps({ aiSuggest: () => Promise.resolve(null) });
  const r = await resolveMarketplaceCategory("grailed", "spacesuit", "gadgets", d);
  assertEquals(r.status, "unmapped");
  assertEquals(r.source, "none");
  assertEquals(d.saved.length, 0);
});
