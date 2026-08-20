// US-2694: record the BRAND's own name for a style code.
//
// Every other source in style_code_names is inference. A market consensus is
// what sellers agree to call something; a seller correction is one person
// reading a tag. The manufacturer's own product name is the answer, which is
// why `official` outranks all of them in lib/style-code-names.ts.
//
// ── THE CATALOGUE DOES NOT PUBLISH THE TAG CODE, WHICH IS THE FINDING ───────
//
// Measured 2026-08-19 from this repo's host, and NOT what a first look suggests:
//
//   robots.txt          200. It ALLOWS product crawling for `User-Agent: *` —
//                       only /search/, some ?Ns= sort params and /api/c/* are
//                       disallowed. `Disallow: /` applies to meta-externalagent
//                       alone. (curl gets 403 here where Node's fetch gets 200;
//                       that is a TLS-fingerprint refusal, not a site policy,
//                       and reading a 403 from one client as "blocked" is how
//                       this was nearly written up wrong.)
//   sitemap.xml         200. 21 child sitemaps, including Product_Sitemap_en_US.
//   product sitemap     200. 3,696 US product URLs, product NAME in the path.
//   a product page      400 {"errorCode":"GE401001"} to a plain client.
//
// The page refusal barely matters, because of the last measurement:
//
//   OF THE 3,696 PRODUCT URLS, ZERO CARRY A TAG STYLE-CODE SHAPE.
//
// The public catalogue is keyed on an internal product id (`prod20000550`), not
// on the W/M style number printed in the garment's size dot. So even a perfect
// crawl yields id -> name, while style_code_names is keyed code -> name. There
// is no join, and no amount of scraping creates one.
//
// That is a stronger result than a 403 would have been: the data is not
// withheld, it is not published in this shape at all. --fetch re-measures all
// four facts on demand so the claim can be rechecked rather than believed.
//
// ── THE PATH THAT DOES WORK ─────────────────────────────────────────────────
//
// --from <file.json> takes rows an operator obtained by hand and writes them
// through the same record_style_code_name RPC everything else uses. Shape:
//
//   [{ "styleCode": "LM7A83S",
//      "name": "Commission Short Relaxed Warpstreme",
//      "colorway": "Black",                        // optional
//      "sourceUrl": "https://shop.lululemon.com/p/..." }]
//
// Usage:
//   node scripts/seed-official-style-names.mjs --fetch          (measures the source)
//   node scripts/seed-official-style-names.mjs --from names.json --dry-run
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/seed-official-style-names.mjs --from names.json

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const doFetch = args.includes("--fetch");
const fromIdx = args.indexOf("--from");
const fromFile = fromIdx !== -1 ? args[fromIdx + 1] : null;
const brandIdx = args.indexOf("--brand");
const brandKey = brandIdx !== -1 ? (args[brandIdx + 1] ?? "").trim() : "lululemon";

/** Uppercased, punctuation-stripped — must match normalizeStyleCode(). */
export function normalizeStyleCode(raw) {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Validate one operator-supplied row. Returns { row } or { error }.
 *
 * Strict on purpose: an `official` row outranks every other source, so a typo
 * here is not a weak answer, it is a wrong answer that wins.
 */
export function validateOfficialRow(raw, index) {
  const where = `row ${index}`;
  if (!raw || typeof raw !== "object") return { error: `${where}: not an object` };
  const code = normalizeStyleCode(raw.styleCode);
  if (code.length < 4) {
    return {
      error: `${where}: styleCode "${raw.styleCode ?? ""}" is too short to be an identity`,
    };
  }
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name.split(/\s+/).filter(Boolean).length < 2) {
    return {
      error: `${where}: name "${name}" is not a product name (needs at least two words)`,
    };
  }
  const sourceUrl = typeof raw.sourceUrl === "string" ? raw.sourceUrl.trim() : "";
  if (!/^https?:\/\//i.test(sourceUrl)) {
    // Not a style preference: brand_styles carries
    // CHECK (brand_fact_is_sourced(source_url, confidence)), and an official
    // claim with no citation is the one thing this table must not hold.
    return { error: `${where}: sourceUrl must be an http(s) URL, got "${sourceUrl}"` };
  }
  const colorway = typeof raw.colorway === "string" ? raw.colorway.trim() : "";
  return {
    row: {
      styleCodeNorm: code,
      styleCodeRaw: String(raw.styleCode).trim(),
      name,
      colorway: colorway || null,
      sourceUrl,
    },
  };
}

/** Do any of these product URLs key on a TAG style code rather than a product
 *  id? This one number decides whether the catalogue can fill our index at all.
 *
 *  Deliberately WIDER than the seeded decoder (00626/00390), which anchors to
 *  the six characters a garment tag prints. Lululemon's own catalogue writes
 *  the same style with a leading "L" (LM7A83S for the tag's M7A83S), and the
 *  2019+ generation appends ".SSYY". A probe that asked only for the tag shape
 *  would report "no join" even in a world where the catalogue published one.
 *  Pure, exported for the test. */
export function tagCodeKeyedUrls(locs) {
  return locs
    .map((l) => l.split("/").filter(Boolean).pop() ?? "")
    .filter((slug) => /^L?[wm][a-z0-9]{4}[a-z](?:\.0[1-4]\d{2})?$/i.test(slug));
}

/**
 * Re-measure the four facts in the header. Never seeds, whatever it finds.
 * Exit 2 means "the catalogue cannot key what we need", which is the state as
 * of 2026-08-19 — a finding, not an error.
 */
async function probeSource() {
  const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
  const get = async (url, accept = "text/html") => {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: accept } });
      return { status: res.status, body: await res.text() };
    } catch (err) {
      return { status: 0, body: String(err.message) };
    }
  };

  console.log("[official-names] measuring the source — this seeds nothing\n");

  const robots = await get("https://shop.lululemon.com/robots.txt", "text/plain");
  // A blanket block is `User-Agent: *` followed by `Disallow: /`. Lululemon's
  // `Disallow: /` belongs to meta-externalagent, so a naive search for the
  // string would read this source as closed when it is open.
  const starBlock = /User-Agent:\s*\*\s*\n(?:(?!User-Agent:)[\s\S])*?^\s*Disallow:\s*\/\s*$/im;
  const blanketBlock = starBlock.test(robots.body);
  console.log(
    `  robots.txt        ${robots.status}` +
      (robots.status === 200
        ? blanketBlock
          ? "  (Disallow: / for *)"
          : "  (product paths permitted for *)"
        : ""),
  );

  const productSitemap = await get(
    "https://shop.lululemon.com/sitemap/Product_Sitemap_en_US.xml",
    "application/xml",
  );
  const locs = [...productSitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  console.log(`  product sitemap   ${productSitemap.status}  (${locs.length} urls)`);

  // THE measurement. Everything above is context for this one line.
  const codeShaped = tagCodeKeyedUrls(locs);
  console.log(`  urls keyed by a TAG style code   ${codeShaped.length} of ${locs.length}`);

  if (locs.length > 0) {
    const page = await get(locs[0]);
    console.log(`  a product page    ${page.status}  ${locs[0]}`);
  }

  if (locs.length > 0 && codeShaped.length === 0) {
    console.error(
      [
        "",
        "[official-names] NO JOIN. The catalogue is keyed on an internal product",
        "id, not on the style number printed in the garment. style_code_names is",
        "keyed code -> name, so a perfect crawl of this source still cannot fill",
        "it. Nothing was seeded, and scraping harder will not change that.",
        "Use --from <file.json> with code/name pairs read off actual tags.",
      ].join("\n"),
    );
    return 2;
  }
  if (codeShaped.length > 0) {
    console.log(
      [
        "",
        "[official-names] the catalogue now exposes tag style codes — the premise",
        "of this script has changed. Write the parser; do not seed from here blind.",
      ].join("\n"),
    );
    return 1;
  }
  console.error("\n[official-names] could not read the catalogue at all; nothing seeded.");
  return 1;
}

async function seedFromFile() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(fromFile, "utf8"));
  } catch (err) {
    console.error(`[official-names] could not read ${fromFile}: ${err.message}`);
    return 1;
  }
  if (!Array.isArray(parsed)) {
    console.error("[official-names] the file must contain a JSON array");
    return 1;
  }

  const rows = [];
  const errors = [];
  parsed.forEach((raw, i) => {
    const result = validateOfficialRow(raw, i + 1);
    if (result.error) errors.push(result.error);
    else rows.push(result.row);
  });

  if (errors.length > 0) {
    // ALL or nothing. A half-seeded official set is the worst outcome: the rows
    // that landed outrank everything, and nobody knows which ones those were.
    console.error(`[official-names] ${errors.length} invalid row(s); nothing was written:`);
    for (const e of errors) console.error(`  ${e}`);
    return 1;
  }

  console.log(`[official-names] ${rows.length} valid row(s) for brand "${brandKey}"`);
  if (dryRun) {
    for (const r of rows) console.log(`  ${r.styleCodeNorm}  ${r.name}`);
    console.log("[official-names] --dry-run: nothing written");
    return 0;
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("[official-names] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    return 1;
  }
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };

  let written = 0;
  let unchanged = 0;
  for (const r of rows) {
    // Read first so a re-run can SAY it changed nothing. record_style_code_name
    // is an upsert, so a blind loop would report N writes every time and the
    // idempotence claim would be untestable.
    const existing = await fetch(
      `${url}/rest/v1/style_code_names?select=name&brand_key=eq.${encodeURIComponent(brandKey)}` +
        `&style_code_norm=eq.${encodeURIComponent(r.styleCodeNorm)}&source=eq.official`,
      { headers },
    );
    const prior = existing.ok ? await existing.json() : [];
    if (prior.length > 0 && prior[0].name === r.name) {
      unchanged++;
      continue;
    }

    const res = await fetch(`${url}/rest/v1/rpc/record_style_code_name`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        p_brand_key: brandKey,
        p_style_code_norm: r.styleCodeNorm,
        p_style_code_raw: r.styleCodeRaw,
        p_name: r.name,
        p_source: "official",
        p_supporting: 1,
        // The manufacturer, cited. Above every derived source's ceiling and
        // still below a decoder reading the code off the garment itself.
        p_confidence: 0.9,
        p_evidence_url: r.sourceUrl,
      }),
    });
    if (!res.ok) {
      console.error(
        `[official-names] ${r.styleCodeNorm} failed: ${res.status} ${await res.text()}`,
      );
      return 1;
    }
    written++;
  }

  console.log(`[official-names] wrote ${written}, unchanged ${unchanged}`);
  return 0;
}

async function main() {
  if (doFetch) return await probeSource();
  if (fromFile) return await seedFromFile();
  console.error("[official-names] pass --fetch (measure the source) or --from <file.json>");
  return 1;
}

if (
  process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/seed-official-style-names.mjs")
) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("[official-names]", err.message);
      process.exit(1);
    });
}
