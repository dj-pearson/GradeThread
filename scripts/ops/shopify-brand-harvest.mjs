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

// Size tokens, which are the commonest thing sitting where a colour would sit.
const SIZE_LIKE =
  /^(x{0,3}s|s|m|l|x{0,3}l|xxl|one size|os|petite|tall|regular|short|long|\d{1,3}(\.\d)?|\d{1,2}(w|l)|\d{1,2}\s*[x/]\s*\d{1,2})$/i;

const stripParen = (s) => s.replace(/\s*[({[][^)}\]]*[)}\]]\s*$/g, "").trim();

/**
 * Colour read from the PRODUCT TITLE, for brands that model each colourway as
 * its own product instead of as a Color variant option (US-3134).
 *
 * Everlane titles read "The Box-Cut Tee in Essential Cotton | Bone Brown";
 * Allbirds "Men's Strider - Natural Black (Dark Grey Sole)". Blundstone's read
 * "Men's Classics #2640" and carry no colour at all -- so this decides PER
 * BRAND whether a separator is really the colour position before trusting any
 * of it, rather than splitting every title and hoping.
 */
export function titleColours(products) {
  const SEPS = [" | ", "|", " - ", " – ", " — "];
  let best = null;
  for (const sep of SEPS) {
    const counts = new Map();
    let withSep = 0;
    for (const p of products) {
      const title = String(p.title ?? "");
      const i = title.lastIndexOf(sep);
      if (i <= 0) continue;
      const tail = stripParen(title.slice(i + sep.length)).replace(/\s+/g, " ").trim();
      if (!tail || tail.length > 40) continue;
      if (SIZE_LIKE.test(tail)) continue;
      if (/^#?\d+$/.test(tail)) continue;      // a style number, not a colour
      if (!/[a-z]/i.test(tail)) continue;
      // A colour name is short. Wax London's titles split into "Black Organic
      // Cotton Twill Shorts" -- a whole product description sitting where a
      // colour would be, which passes coverage and cardinality easily and is
      // entirely wrong. Three words is the ceiling: "Trench Coat Khaki" and
      // "Dark Olive Suede" are real, five-word tails never are.
      if (tail.split(" ").length > 3) continue;
      withSep += 1;
      counts.set(tail, (counts.get(tail) ?? 0) + 1);
    }
    const coverage = products.length ? withSep / products.length : 0;
    if (!best || coverage > best.coverage) {
      best = { separator: sep, coverage, counts };
    }
  }
  // Both bars matter. Coverage says the separator is the brand's convention
  // rather than an accident in a few titles; cardinality says the tail VARIES,
  // which is what makes it a colour instead of a repeated marketing suffix.
  const ok = best && best.coverage >= 0.5 && best.counts.size >= 8;
  return {
    separator: ok ? best.separator : null,
    coverage: best ? Number(best.coverage.toFixed(3)) : 0,
    colours: ok
      ? [...best.counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      : [],
  };
}

/** Everything the KB cares about, counted. */
export function summarise(products) {
  const colours = new Map();
  const sizes = new Map();
  const types = new Map();
  const styles = new Map();
  const skuPrefixes = new Map();
  const skus = [];
  const facets = new Map();
  const colourFamily = {};
  const bump = (m, k) => k && m.set(k, (m.get(k) ?? 0) + 1);

  for (const p of products) {
    for (const c of optionValues(p, "color")) bump(colours, String(c).trim());
    for (const s of optionValues(p, "size")) bump(sizes, String(s).trim());
    bump(types, p.product_type);
    // Shopify tags carry a brand's own taxonomy far more often than
    // product_type does. `product_style: X` is Free Fly's; other brands differ,
    // so anything shaped `key: value` is collected rather than one hard-coded key.
    // ⚠ NAMESPACED TAGS ARE WHERE THE ANSWERS ARE, and the first version of this
    // tool only looked for `*style*:`. Brands namespace their own filter facets
    // — 7 For All Mankind carries `wash::Grey`, `fit::Flare`, `fabric::Denim`,
    // `age_group::Womens`. `wash::` is the colour FAMILY for a denim wash name,
    // which no colour table can ever derive from "Halona" or "Coffee Bean". It
    // was sitting in the feed the whole time.
    const tagColours = [];
    for (const t of p.tags ?? []) {
      const raw = String(t);
      const m = /^([a-z_]+)\s*::?\s*(.+)$/i.exec(raw);
      if (!m) continue;
      const ns = m[1].toLowerCase();
      const val = m[2].trim();
      if (!val) continue;
      bump(facets, `${ns}::${val}`);
      if (ns.includes("style")) bump(styles, val);
      // A wash or colour-family facet, kept beside the colour it shipped with.
      if (ns === "wash" || ns === "color" || ns === "colour" || ns === "colorfamily" ||
          ns === "color_family" || ns === "colour_family") {
        tagColours.push(val);
      }
    }
    if (tagColours.length) {
      for (const c of optionValues(p, "color")) {
        const key = String(c).trim();
        if (!key) continue;
        if (!colourFamily[key]) colourFamily[key] = {};
        for (const f of tagColours) {
          colourFamily[key][f] = (colourFamily[key][f] ?? 0) + 1;
        }
      }
    }
    for (const v of p.variants ?? []) {
      const sku = String(v.sku ?? "");
      const m = /^([A-Z]{2,5})\d/.exec(sku);
      if (m) bump(skuPrefixes, m[1]);
      // ⚠ THE SKU IS KEPT WITH ITS COLOUR AND SIZE, not on its own. A decoder is
      // only worth writing if a segment RESOLVES to something, and the only way
      // to know whether the digits in the middle are a colourway id is to check
      // the same code against the colour it shipped with across styles. Free
      // Fly's looked like one and was not (US-3125, 00732).
      if (sku && skus.length < 4000) {
        skus.push({ sku, colour: v.option1 ?? null, size: v.option2 ?? null });
      }
    }
  }
  const top = (m, n) =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
  const fromTitle = titleColours(products);
  // Three states, not two. "The feed declares no Color option" and "this tool
  // could not read one" are different claims and the KB records different
  // things for them (US-3134).
  const hasColorOption = products.some((p) =>
    (p.options ?? []).some((o) => String(o.name).toLowerCase() === "color"),
  );
  return {
    productCount: products.length,
    colours: top(colours, 400),
    // Where `colours` came from: a declared variant option, a parsed title, or
    // nowhere. A title is a heuristic and an option is a declaration, so a
    // consumer must be able to tell them apart and price them differently.
    colourSource: colours.size ? "option" : fromTitle.colours.length ? "title" : "none",
    hasColorOption,
    titleColours: fromTitle.colours.slice(0, 400),
    titleSeparator: fromTitle.separator,
    titleCoverage: fromTitle.coverage,
    sizes: top(sizes, 60),
    types: top(types, 30),
    styles: top(styles, 200),
    skuPrefixes: top(skuPrefixes, 40),
    skus,
    facets: top(facets, 400),
    colourFamily,
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
  if (s.colourSource !== "option") problems.push(`colourSource ${s.colourSource}`);
  if (!s.hasColorOption) problems.push("hasColorOption false on an option feed");

  // US-3134: the three feed shapes, each of which must be told apart.
  //
  // 1. Colour in the TITLE, one product per colourway (Everlane, Allbirds).
  const titleFeed = Array.from({ length: 10 }, (_, i) => ({
    title: `The Cotton Crew | ${["Bone Brown", "Deep Navy", "Black", "Optical White",
      "Sage", "Rust", "Clay", "Sand", "Ink", "Moss"][i]}`,
    options: [{ name: "Size", values: ["S", "M"] }],
  }));
  const t = summarise(titleFeed);
  if (t.colourSource !== "title") problems.push(`title feed colourSource ${t.colourSource}`);
  if (t.hasColorOption) problems.push("title feed claimed a Color option");
  if (t.titleColours.length !== 10) problems.push(`title colours ${t.titleColours.length}`);
  if (!t.titleColours.some(([c]) => c === "Bone Brown")) problems.push("Bone Brown");

  // A parenthetical after the colour is stripped, and a size-shaped tail is not
  // a colour however consistently it appears.
  const parenFeed = Array.from({ length: 10 }, (_, i) => ({
    title: `Men's Strider - ${["Natural Black", "Medium Grey", "Blizzard", "Anthracite",
      "Rust", "Fern", "Chalk", "Hazy Indigo", "Thunder", "Lux Beige"][i]} (Dark Grey Sole)`,
    options: [{ name: "Size", values: ["9"] }],
  }));
  const pf = summarise(parenFeed);
  if (!pf.titleColours.some(([c]) => c === "Natural Black")) {
    problems.push(`paren strip: ${JSON.stringify(pf.titleColours.slice(0, 3))}`);
  }
  // Every tail here is a WORD, so the numeric reject and the 8-distinct bar
  // both pass it through -- SIZE_LIKE is the only rule that can catch this one.
  // (An earlier version used numeric sizes and stayed green with SIZE_LIKE
  // deleted, which made it a test of the cardinality bar wearing a size label.)
  const sizeFeed = Array.from({ length: 10 }, (_, i) => ({
    title: `The Jean - ${["XS", "S", "M", "L", "XL", "XXL", "One Size", "Petite",
      "Tall", "Regular"][i]}`,
    options: [{ name: "Waist", values: ["28"] }],
  }));
  if (summarise(sizeFeed).colourSource !== "none") problems.push("size tails read as colour");

  // 2. Neither: a style-number catalogue (Blundstone) must stay "none", so the
  //    KB never records a parsed colour that is really a product code.
  const noneFeed = Array.from({ length: 10 }, (_, i) => ({
    title: `Men's Classics #${2600 + i}`,
    options: [{ name: "Size", values: ["8"] }],
  }));
  const nf = summarise(noneFeed);
  if (nf.colourSource !== "none") problems.push(`style-number feed read as ${nf.colourSource}`);
  if (nf.titleColours.length) problems.push("style numbers parsed as colours");

  // 3. A separator that appears in only a FEW titles is not the brand's
  //    convention and must not be trusted.
  const rareFeed = Array.from({ length: 20 }, (_, i) => ({
    title: i < 3 ? `Thing | Colour${i}` : `Plain Thing ${i}`,
    options: [{ name: "Size", values: ["M"] }],
  }));
  if (summarise(rareFeed).colourSource !== "none") problems.push("rare separator trusted");

  // 4. A separator that splits off a whole PRODUCT DESCRIPTION rather than a
  //    colour. This is Wax London, and it clears coverage and cardinality with
  //    room to spare -- only the word-count ceiling catches it.
  const describedFeed = Array.from({ length: 12 }, (_, i) => ({
    title: `Wax London - ${["Black Organic Cotton Twill Shorts",
      "Ecru Diamond Stripe Knitted Polo", "Navy Textured Organic Cotton Polo Shirt",
      "Beige Washed Linen Loose Fit Trousers", "Green Slub Cotton Overshirt",
      "Brown Corduroy Wide Leg Trouser", "Blue Herringbone Linen Jacket",
      "Grey Merino Wool Crew Knit", "Cream Waffle Cotton Long Sleeve",
      "Rust Garment Dyed Cotton Tee", "Sage Ripstop Cotton Cap",
      "Stone Washed Denim Chore Jacket"][i]}`,
    options: [{ name: "Size", values: ["M"] }],
  }));
  const df = summarise(describedFeed);
  if (df.colourSource !== "none") {
    problems.push(`product descriptions read as colours: ${JSON.stringify(df.titleColours.slice(0, 2))}`);
  }

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
