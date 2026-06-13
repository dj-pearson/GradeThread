// US-722: validateMapping guards the admin category-map upsert. Set dummy
// supabase env first (the route module loads supabase at init).
//   deno test --allow-env src/tests/admin-category-map_test.ts
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { validateMapping } = await import("../routes/admin-category-map.ts");

Deno.test("accepts a valid no-API mapping and normalizes the garment key", () => {
  const r = validateMapping({
    platform: "poshmark",
    gradethread_garment: "  Tops ",
    platform_category: " Tops ",
    department: " Women ",
  });
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.value.platform, "poshmark");
    assertEquals(r.value.gradethread_garment, "tops");
    assertEquals(r.value.platform_category, "Tops");
    assertEquals(r.value.department, "Women");
  }
});

Deno.test("rejects eBay/Shopify and unknown platforms", () => {
  for (const platform of ["ebay", "shopify", "nope"]) {
    const r = validateMapping({
      platform,
      gradethread_garment: "tops",
      platform_category: "Tops",
    });
    assert(!r.ok);
  }
});

Deno.test("requires garment + category", () => {
  assert(!validateMapping({ platform: "mercari", platform_category: "Tops" }).ok);
  assert(!validateMapping({ platform: "mercari", gradethread_garment: "tops" }).ok);
});

Deno.test("department is optional → null", () => {
  const r = validateMapping({
    platform: "grailed",
    gradethread_garment: "outerwear",
    platform_category: "Outerwear",
  });
  assert(r.ok);
  if (r.ok) assertEquals(r.value.department, null);
});
