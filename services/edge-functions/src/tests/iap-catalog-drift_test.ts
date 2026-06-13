// US-808: drift guard between the canonical server catalog
// (lib/appstore/products.ts) and the iOS offline fallback
// (ios/GradeThread/Billing/IAPProduct.swift). The Swift entries are the offline
// fallback only — but their product ids, credits, plan/interval, and fallback
// display price MUST agree with the server, or a category-change/price drift
// goes unnoticed. This test parses the Swift source and fails on any divergence.

import { assertEquals } from "@std/assert";
import { serializeCatalog } from "../lib/appstore/products.ts";

const SWIFT_PATH = new URL(
  "../../../../ios/GradeThread/Billing/IAPProduct.swift",
  import.meta.url,
);

interface SwiftEntry {
  productId: string;
  kind: "subscription" | "consumable";
  plan?: string;
  interval?: string;
  credits?: number;
  fallbackPrice: string;
}

/** Parse the IAPCatalogEntry(...) literals out of IAPProduct.swift. */
function parseSwiftCatalog(source: string): SwiftEntry[] {
  // Each entry begins at an `IAPCatalogEntry(` token; take the text up to the
  // next one (or EOF) as that entry's body.
  const chunks = source.split("IAPCatalogEntry(").slice(1);
  const entries: SwiftEntry[] = [];

  for (const chunk of chunks) {
    const productId = chunk.match(/productId:\s*"([^"]+)"/)?.[1];
    const fallbackPrice = chunk.match(/fallbackPrice:\s*"([^"]+)"/)?.[1];
    if (!productId || fallbackPrice === undefined) continue;

    const sub = chunk.match(
      /kind:\s*\.subscription\(plan:\s*"([^"]+)",\s*interval:\s*"([^"]+)"\)/,
    );
    const consumable = chunk.match(/kind:\s*\.consumable\(credits:\s*(\d+)\)/);

    if (sub) {
      entries.push({
        productId,
        kind: "subscription",
        plan: sub[1],
        interval: sub[2],
        fallbackPrice,
      });
    } else if (consumable) {
      entries.push({
        productId,
        kind: "consumable",
        credits: Number(consumable[1]),
        fallbackPrice,
      });
    }
  }
  return entries;
}

const swiftEntries = parseSwiftCatalog(Deno.readTextFileSync(SWIFT_PATH));
const swiftById = new Map(swiftEntries.map((e) => [e.productId, e]));
const catalog = serializeCatalog();
const catalogIds = catalog.map((p) => p.productId).sort();
const swiftIds = swiftEntries.map((e) => e.productId).sort();

Deno.test("iOS fallback catalog has the same product ids as the server", () => {
  assertEquals(swiftIds, catalogIds);
});

Deno.test("iOS fallback entries match server mapping + reference price", () => {
  for (const product of catalog) {
    const swift = swiftById.get(product.productId);
    assertEquals(
      swift !== undefined,
      true,
      `iOS IAPProduct.swift is missing product ${product.productId}`,
    );
    if (!swift) continue;

    assertEquals(
      swift.kind,
      product.kind,
      `kind drift for ${product.productId}`,
    );

    if (product.kind === "subscription") {
      assertEquals(
        { plan: swift.plan, interval: swift.interval },
        { plan: product.plan, interval: product.interval },
        `plan/interval drift for ${product.productId}`,
      );
    } else {
      assertEquals(
        swift.credits,
        product.credits,
        `credits drift for ${product.productId}`,
      );
    }

    assertEquals(
      swift.fallbackPrice,
      product.referencePriceDisplay,
      `fallback price drift for ${product.productId} ` +
        `(iOS "${swift.fallbackPrice}" vs catalog "${product.referencePriceDisplay}")`,
    );
  }
});
