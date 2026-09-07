#!/usr/bin/env node
// US-3125 — which brands in the KB publish a catalogue we can read?
//
// `brand_knowledge.source_url` already holds each brand's homepage. This asks
// each origin for Shopify's default `/products.json` and reports which answer
// with the feed, so a colorway/style backfill can be aimed at the brands where
// first-party data actually exists instead of guessed at brand by brand.
//
// ⚠ FOUR OUTCOMES, NOT TWO, and collapsing them is the whole trap:
//
//   feed      the endpoint returned the products array. Harvestable.
//   none      a 404, or a 200 whose body is not the feed. Not Shopify.
//   refused   403 / 429 / 503. The brand HAS a catalogue and declined to serve
//             it to automation. Retryable, and NOT evidence of anything.
//   error     DNS, TLS, timeout. Says nothing about the brand.
//
// A run that reports `refused` as `none` would quietly write off brands that
// are merely rate-limiting, and nobody would look again. That is why 403 and
// 429 get their own bucket: Todd Snyder answered 403 and Beyond Yoga 429 on
// 2026-09-06, and both are ordinary Shopify stores.
//
// ⚠ A 200 IS NOT A FEED. petermillar.com returns an Imperva block page with
// HTTP 200. The body is parsed, not the status.
//
// Input is `brand_key|https://origin/` per line, which is what this SQL prints:
//
//   select brand_key || '|' || source_url from public.brand_knowledge
//    where source_url like 'http%'
//      and brand_key not in (select distinct brand_key from public.brand_colorways);
//
// Run:  node scripts/ops/brand-feed-probe.mjs candidates.txt
//       node scripts/ops/brand-feed-probe.mjs --feeds-only candidates.txt
//       node scripts/ops/brand-feed-probe.mjs --self-test

import { readFileSync } from "node:fs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";
const CONCURRENCY = 6;

/**
 * The origin to ask, or null when the recorded URL is not the brand's own site.
 *
 * Some rows cite a third party — adidas' source_url is a sneakerfreaker.com
 * article. Probing that would ask a magazine for adidas' catalogue and record
 * the answer against adidas.
 */
export function originOf(sourceUrl, brandKey) {
  let u;
  try {
    u = new URL(sourceUrl);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const label = host.split(".")[0].replace(/[^a-z0-9]/g, "");
  const key = brandKey.replace(/[^a-z0-9]/g, "");
  // The host must plausibly BE the brand: its first label shares a prefix with
  // the brand key either way round. `agjeans` <-> `agjeans`, `jcrew` <-> `jcrew`,
  // but `sneakerfreaker` <-> `adidas` fails and is skipped.
  const related =
    label.startsWith(key.slice(0, 5)) || key.startsWith(label.slice(0, 5));
  return related ? `${u.protocol}//${u.host}` : null;
}

export function classify(status, body) {
  if (status === 403 || status === 429 || status === 503) return "refused";
  if (!status || status >= 500) return "error";
  if (status !== 200) return "none";
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed.products) ? "feed" : "none";
  } catch {
    // A 200 carrying HTML is a storefront or a bot challenge, never a feed.
    return "none";
  }
}

async function probe(origin) {
  const url = `${origin}/products.json?limit=1`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    const body = res.status === 200 ? await res.text() : "";
    return classify(res.status, body);
  } catch {
    return "error";
  }
}

function selfTest() {
  const cases = [
    [classify(200, '{"products":[]}'), "feed"],
    [classify(200, "<!DOCTYPE html><html>"), "none"],
    [classify(200, '{"errors":"not found"}'), "none"],
    [classify(404, ""), "none"],
    [classify(403, ""), "refused"],
    [classify(429, ""), "refused"],
    [classify(503, ""), "refused"],
    [classify(500, ""), "error"],
    [classify(0, ""), "error"],
    [originOf("https://www.agjeans.com/", "agjeans"), "https://www.agjeans.com"],
    [originOf("https://www.sneakerfreaker.com/news/adidas", "adidas"), null],
    [originOf("not a url", "x"), null],
  ];
  const bad = cases.filter(([got, want]) => got !== want);
  if (bad.length) {
    console.error("brand-feed-probe self-test FAILED:", bad);
    return 1;
  }
  console.log(`brand-feed-probe self-test: ${cases.length} cases OK.`);
  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) return selfTest();
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: brand-feed-probe.mjs [--feeds-only] <candidates.txt>");
    return 2;
  }

  const rows = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [key, url] = l.split("|");
      return { key, url, origin: originOf(url ?? "", key ?? "") };
    });

  const results = [];
  const queue = rows.slice();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const row = queue.shift();
        if (!row) return;
        const state = row.origin ? await probe(row.origin) : "skipped";
        results.push({ ...row, state });
      }
    }),
  );
  results.sort((a, b) => a.key.localeCompare(b.key));

  const feeds = results.filter((r) => r.state === "feed");
  if (args.includes("--feeds-only")) {
    for (const r of feeds) console.log(`${r.key}|${r.origin}`);
    return 0;
  }

  const counts = {};
  for (const r of results) counts[r.state] = (counts[r.state] ?? 0) + 1;
  console.log(
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join("   "),
  );
  console.log(`\nFEED (${feeds.length}) — harvestable now:`);
  for (const r of feeds) console.log(`  ${r.key.padEnd(22)} ${r.origin}`);
  const refused = results.filter((r) => r.state === "refused");
  console.log(`\nREFUSED (${refused.length}) — has a catalogue, declined us. Retry:`);
  console.log("  " + refused.map((r) => r.key).join(", "));
  const skipped = results.filter((r) => r.state === "skipped");
  console.log(`\nSKIPPED (${skipped.length}) — source_url is not the brand's own site:`);
  console.log("  " + skipped.map((r) => r.key).join(", "));
  return 0;
}

main().then((c) => process.exit(c));
