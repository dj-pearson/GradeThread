// Pure product-catalog mapping. Mirrors the iOS client map; fail-closed on
// unknown ids.

import { assertEquals } from "@std/assert";
import {
  ACTION_CREDIT_PRODUCT_IDS,
  CATALOG,
  classifyProduct,
  CONSUMABLE_PRODUCT_IDS,
  ONE_TIME_PRODUCT_IDS,
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

// This said "6 subscriptions + 4 consumables" and asserted a catalog of 10.
// US-3138 then added four Action Credit packs, a THIRD kind, and the count went
// to 14. The guard failed on the total and said nothing about the new kind,
// because it did not know one could exist.
//
// A hard-coded total only notices growth it was told to expect. What actually
// matters is that the three id lists PARTITION the catalog: every entry lands
// in exactly one, and nothing lands in none. A fourth kind then fails here on
// the day it is added, rather than whenever someone next reads the number.
Deno.test("the id lists partition the catalog — every product, exactly once", () => {
  const buckets = [
    ["subscription", SUBSCRIPTION_PRODUCT_IDS],
    ["consumable", CONSUMABLE_PRODUCT_IDS],
    ["action_credits", ACTION_CREDIT_PRODUCT_IDS],
  ] as const;

  const seen = new Map<string, string>();
  for (const [kind, ids] of buckets) {
    for (const id of ids) {
      const already = seen.get(id);
      assertEquals(already, undefined, `${id} is in both ${already} and ${kind}`);
      seen.set(id, kind);
    }
  }

  const catalogIds = CATALOG.map((e) => e.productId).sort();
  assertEquals([...seen.keys()].sort(), catalogIds, "a product is in no id list");
  assertEquals(Object.keys(PRODUCT_MAP).sort(), catalogIds, "PRODUCT_MAP drifted from CATALOG");
  // Every entry's own mapping.kind agrees with the list it landed in, so a
  // mis-filed product cannot pass by being counted somewhere.
  for (const entry of CATALOG) {
    assertEquals(seen.get(entry.productId), entry.mapping.kind, entry.productId);
  }
});

Deno.test("the catalog is the size we think it is", () => {
  // Kept as counts on purpose: adding a product to an EXISTING kind is a
  // pricing change, and a pricing change should have to be typed here too.
  assertEquals(SUBSCRIPTION_PRODUCT_IDS.length, 6, "3 tiers x monthly/yearly");
  assertEquals(CONSUMABLE_PRODUCT_IDS.length, 4, "grade packs: 10, 25, 50, 100");
  assertEquals(ACTION_CREDIT_PRODUCT_IDS.length, 4, "action packs: 50, 150, 400, 1000");
  assertEquals(CATALOG.length, 14);
});

Deno.test("US-3138: grade packs and action packs stay different wallets", () => {
  // StoreKit calls both "consumable". The server must not: crediting an action
  // pack into the grade wallet would hand a seller the wrong thing they paid
  // for. The two lists must therefore never share an id, and ONE_TIME must be
  // exactly their union.
  const grades = new Set(CONSUMABLE_PRODUCT_IDS);
  for (const id of ACTION_CREDIT_PRODUCT_IDS) {
    assertEquals(grades.has(id), false, `${id} is in both wallets`);
  }
  assertEquals(
    ONE_TIME_PRODUCT_IDS.slice().sort(),
    [...CONSUMABLE_PRODUCT_IDS, ...ACTION_CREDIT_PRODUCT_IDS].sort(),
  );
});
