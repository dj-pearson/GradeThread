// 2026-09-02: attributes.model projects onto the leaf's Model aspect, fill-only.
//   deno test --allow-env src/tests/aspect-registry-model_test.ts
import { assertEquals } from "@std/assert";
import { ASPECT_REGISTRY, resolveItemAspects } from "../lib/aspect-registry.ts";

const aspects = [
  { name: "Model", mode: "FREE_TEXT", multi: false },
  { name: "Style Code", mode: "FREE_TEXT", multi: false },
];

Deno.test("attributes.model fills Model; attributes.mpn fills Style Code", () => {
  const out = resolveItemAspects(
    {
      item_category: "clothing",
      attributes: { model: "Scuba Oversized Half-Zip", mpn: "W3CWDS" },
    },
    aspects,
    {},
  );
  assertEquals(out.Model, ["Scuba Oversized Half-Zip"]);
  assertEquals(out["Style Code"], ["W3CWDS"]);
});

Deno.test("Model is never overwritten when already set", () => {
  const out = resolveItemAspects(
    { item_category: "clothing", attributes: { model: "Scuba" } },
    aspects,
    { Model: ["Define Jacket"] },
  );
  assertEquals(out.Model, undefined);
});

Deno.test("the model entry exists and the registry version moved for it", () => {
  assertEquals(ASPECT_REGISTRY.entries.some((e) => e.key === "model"), true);
  assertEquals(ASPECT_REGISTRY.version >= 6, true);
});
