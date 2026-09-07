#!/usr/bin/env node
// US-3125 — harvest a brand's OWN catalogue into brand-KB shape.
//
// Many apparel brands run Shopify, and Shopify serves `/products.json` to
// anyone. That is a FIRST-PARTY source: the colour names are the brand's own
// names, the size run is the brand's own run, and the SKU is the brand's own
// style code. It is the difference between "Slate Blue" as the brand says it and
// a reseller's guess at "blue".
//
// ⚠ WHAT THIS IS NOT: a scraper for brands that said no. Plenty of sites refuse
// automation (petermillar.com serves an Imperva block page, and serves it as
// HTTP 200 so a status check reads it as success). This tool only reads a
// documented JSON endpoint that the platform publishes by default, and it stops
// the moment the response is not that JSON.
//
// ⚠ AND IT DOES NOT WRITE ANYTHING. It prints a summary for a human to turn into
// a migration, because the judgements that matter — is this colour a real
// colorway or a one-off collab, is this SKU prefix a decodable pattern or a
// coincidence — are not in the data.
//
// Run:  node scripts/ops/shopify-brand-harvest.mjs https://freeflyapparel.com
//       node scripts/ops/shopify-brand-harvest.mjs --json https://freeflyapparel.com
//       node scripts/ops/shopify-brand-harvest.mjs --self-test

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";
const PAGE = 250;

export class NotAShopifyFeed extends Error {
  constructor(m) {
    super(m);
    this.name = "NotAShopifyFeed";
  }
}

/**
 * Pull every product page.
 *
 * Throws rather than returning [] when the endpoint is not the feed. A silent
 * empty result here reads as "this brand sells nothing", which is never true and
 * would send someone off to find a different source for no reason.
 */
export async function fetchAll(origin, fetchImpl = fetch) {
  const products = [];
  for (let page = 1; page <= 40; page++) {
    const url = `${origin.replace(/\/$/, "")}/products.json?limit=${PAGE}&page=${page}`;
    // ⚠ BACK OFF ON 429 RATHER THAN GIVING UP. Shopify rate-limits by IP across
    // ALL its stores, so harvesting brands back to back gets the whole run
    // throttled — 34 of 45 brands failed this way on the first attempt, and not
    // one of them was actually unavailable. Retrying politely is both the
    // correct behaviour and the one that works.
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await fetchImpl(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status !== 429 || attempt >= 4) break;
      const retryAfter = Number(res.headers?.get?.("retry-after")) || 0;
      const wait = retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, wait));
    }
    if (!res.ok) {
      if (page === 1) throw new NotAShopifyFeed(`${url} answered HTTP ${res.status}`);
      break;
    }
    // One page per second is plenty for a catalogue that changes seasonally.
    await new Promise((r) => setTimeout(r, 1000));
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new NotAShopifyFeed(
        `${url} answered 200 but the body is not JSON — almost certainly a bot ` +
          `challenge or a storefront page. A 200 is not evidence of a feed.`,
      );
    }
    if (!Array.isArray(body.products)) {
      throw new NotAShopifyFeed(`${url} returned JSON with no products array`);
    }
    if (body.products.length === 0) break;
    products.push(...body.products);
    if (body.products.length < PAGE) break;
  }
  return products;
}

const optionValues = (product, name) => {
  const o = (product.options ?? []).find(
    (x) => String(x.name).toLowerCase() === name,
  );
  return o ? o.values : [];
};

/** Everything the KB cares about, counted. */
export function summarise(products) {
  const colours = new Map();
  const sizes = new Map();
  const types = new Map();
  const styles = new Map();
  const skuPrefixes = new Map();
  const bump = (m, k) => k && m.set(k, (m.get(k) ?? 0) + 1);

  for (const p of products) {
    for (const c of optionValues(p, "color")) bump(colours, String(c).trim());
    for (const s of optionValues(p, "size")) bump(sizes, String(s).trim());
    bump(types, p.product_type);
    // Shopify tags carry a brand's own taxonomy far more often than
    // product_type does. `product_style: X` is Free Fly's; other brands differ,
    // so anything shaped `key: value` is collected rather than one hard-coded key.
    for (const t of p.tags ?? []) {
      const m = /^([a-z_]*style[a-z_]*)\s*:\s*(.+)$/i.exec(String(t));
      if (m) bump(styles, m[2].trim());
    }
    for (const v of p.variants ?? []) {
      const m = /^([A-Z]{2,5})\d/.exec(String(v.sku ?? ""));
      if (m) bump(skuPrefixes, m[1]);
    }
  }
  const top = (m, n) =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
  return {
    productCount: products.length,
    colours: top(colours, 400),
    sizes: top(sizes, 60),
    types: top(types, 30),
    styles: top(styles, 200),
    skuPrefixes: top(skuPrefixes, 40),
  };
}

function selfTest() {
  const sample = [
    {
      product_type: "Men's",
      tags: ["care::bamboo", "product_style: Mens Bamboo Motion Boxer Brief"],
      options: [
        { name: "Color", values: ["Slate Blue", "Black"] },
        { name: "Size", values: ["S", "M"] },
      ],
      variants: [{ sku: "BBB447-S" }, { sku: "BBB447-M" }],
    },
    {
      product_type: "Women's",
      tags: ["product_style: Womens Bamboo Flex Tank"],
      options: [{ name: "Color", values: ["Slate Blue"] }],
      variants: [{ sku: "WBF102-S" }],
    },
  ];
  const s = summarise(sample);
  const problems = [];
  if (s.productCount !== 2) problems.push("productCount");
  // Slate Blue appears in both products: counted twice, listed once.
  const slate = s.colours.find(([c]) => c === "Slate Blue");
  if (!slate || slate[1] !== 2) problems.push(`Slate Blue count ${slate?.[1]}`);
  if (s.colours.length !== 2) problems.push(`colours ${s.colours.length}, expected 2`);
  if (s.styles.length !== 2) problems.push(`styles ${s.styles.length}, expected 2`);
  const bbb = s.skuPrefixes.find(([p]) => p === "BBB");
  if (!bbb || bbb[1] !== 2) problems.push("BBB prefix");
  if (!s.types.some(([t]) => t === "Women's")) problems.push("product_type");

  // A 200 carrying a bot challenge must THROW, not read as an empty catalogue.
  let threw = false;
  const htmlFetch = async () => ({ ok: true, text: async () => "<!DOCTYPE html><html>" });
  return fetchAll("https://example.test", htmlFetch)
    .catch((e) => {
      threw = e instanceof NotAShopifyFeed;
    })
    .then(() => {
      if (!threw) problems.push("a 200 with an HTML body did not throw");
      if (problems.length) {
        console.error("shopify-brand-harvest self-test FAILED:", problems.join("; "));
        return 1;
      }
      console.log("shopify-brand-harvest self-test: summarise + bot-challenge guard OK.");
      return 0;
    });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) return selfTest();
  const origin = args.find((a) => !a.startsWith("--"));
  if (!origin) {
    console.error("usage: shopify-brand-harvest.mjs [--json] <https://brand.com>");
    return 2;
  }
  let products;
  try {
    products = await fetchAll(origin);
  } catch (e) {
    console.error(`${origin}\n  ${e.name}: ${e.message}`);
    return 1;
  }
  const s = summarise(products);
  if (args.includes("--json")) {
    console.log(JSON.stringify(s, null, 2));
    return 0;
  }
  const list = (rows, n) =>
    rows.slice(0, n).map(([v, c]) => `${v} (${c})`).join(", ");
  console.log(`${origin}\n  ${s.productCount} products`);
  console.log(`\n  COLOURS (${s.colours.length} distinct)\n    ${list(s.colours, 60)}`);
  console.log(`\n  SIZES (${s.sizes.length})\n    ${list(s.sizes, 40)}`);
  console.log(`\n  DEPARTMENTS\n    ${list(s.types, 20)}`);
  console.log(`\n  STYLE NAMES (${s.styles.length})\n    ${list(s.styles, 40)}`);
  console.log(`\n  SKU PREFIXES\n    ${list(s.skuPrefixes, 30)}`);
  return 0;
}

main().then((c) => process.exit(c));
