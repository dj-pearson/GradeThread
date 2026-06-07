// Pure product-catalog mapping. Mirrors the iOS client map; fail-closed on
// unknown ids.

import { assertEquals } from "@std/assert";
import {
  classifyProduct,
  CONSUMABLE_PRODUCT_IDS,
  PRODUCT_MAP,
  SUBSCRIPTION_PRODUCT_IDS,
} from "../lib/appstore/products.ts";

Deno.test("classifyProduct maps subscriptions", () => {
  assertEquals(classifyProduct("com.gradethread.sub.pro.monthly"), {
    kind: "subscription",
    plan: "pro",
    interval: "monthly",
  });
  assertEquals(classifyProduct("com.gradethread.sub.business.yearly"), {
    kind: "subscription",
    plan: "business",
    interval: "yearly",
  });
});

Deno.test("classifyProduct maps consumables", () => {
  assertEquals(classifyProduct("com.gradethread.credits.50"), {
    kind: "consumable",
    credits: 50,
  });
});

Deno.test("classifyProduct fails closed on unknown ids", () => {
  assertEquals(classifyProduct("com.gradethread.sub.enterprise.monthly"), null);
  assertEquals(classifyProduct(""), null);
  assertEquals(classifyProduct("com.gradethread.credits.999"), null);
});

Deno.test("catalog has 6 subscriptions + 4 consumables", () => {
  assertEquals(Object.keys(PRODUCT_MAP).length, 10);
  assertEquals(SUBSCRIPTION_PRODUCT_IDS.length, 6);
  assertEquals(CONSUMABLE_PRODUCT_IDS.length, 4);
});
