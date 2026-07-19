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
  // US-2123: the USER-FACING strings. These were parsed by nothing and compared
  // by nothing, so iOS advertised "1,000 AI actions" for Pro while the server
  // granted 750 — a paid-for entitlement that did not exist. The guard had a
  // hole exactly where the misleading copy lived.
  title: string;
  blurb: string;
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
    const title = chunk.match(/title:\s*"([^"]*)"/)?.[1];
    const blurb = chunk.match(/blurb:\s*"([^"]*)"/)?.[1];
    if (!productId || fallbackPrice === undefined) continue;
    if (title === undefined || blurb === undefined) continue;

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
        title,
        blurb,
      });
    } else if (consumable) {
      entries.push({
        productId,
        kind: "consumable",
        credits: Number(consumable[1]),
        fallbackPrice,
        title,
        blurb,
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

// US-2123: the drift guard compared ids, mapping, credits and price — every
// machine-readable field — but NOT the two strings the buyer actually reads.
// So iOS could advertise "1,000 AI actions" against a server that grants 750
// and CI stayed green. Advertised entitlements are the ones a purchase is made
// against; they are exactly as load-bearing as the price, and now guarded the
// same way.
// Collected rather than asserted per-product on purpose: a per-product assert
// stops at the FIRST mismatch, which turns "audit every advertised number"
// (US-2123 AC3) into "find one and guess about the rest". This reports all of
// them in one run.
Deno.test("iOS paywall copy matches the entitlements the server advertises", () => {
  const drift: string[] = [];

  for (const product of catalog) {
    const swift = swiftById.get(product.productId);
    if (!swift) continue;

    if (swift.title !== product.title) {
      drift.push(
        `${product.productId} TITLE\n` +
          `    iOS:    "${swift.title}"\n` +
          `    server: "${product.title}"`,
      );
    }
    if (swift.blurb !== product.blurb) {
      drift.push(
        `${product.productId} BLURB (advertised entitlement)\n` +
          `    iOS:    "${swift.blurb}"\n` +
          `    server: "${product.blurb}"`,
      );
    }
  }

  assertEquals(
    drift,
    [],
    `iOS paywall copy does not match the server catalog:\n\n${drift.join("\n\n")}\n\n` +
      `An iOS buyer is sold the iOS string and gated by the server one. If the ` +
      `copy is right, change the entitlement; if the entitlement is right, ` +
      `change the copy — but they must agree.`,
  );
});
