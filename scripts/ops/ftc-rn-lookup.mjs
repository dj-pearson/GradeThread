#!/usr/bin/env node
// US-3128 — look a brand up in the FTC's RN register.
//
// An RN (Registered Identification Number) or CA (its Canadian equivalent) is
// the one identity string on a care label issued by a government registry, so a
// seller cannot type it into existence. This queries the register for it.
//
// ⚠ THE REGISTER IS OPEN. IT WAS RECORDED HERE FOR MONTHS AS AUTH-GATED AND IT
// IS NOT. https://www.ftc.gov/rn-database/search answers 200 to a plain
// unauthenticated GET and takes a `search=` query string. That false premise sat
// in registered-numbers.ts and in brand-kb-negative-findings.md and is why the
// registered_numbers column covers 6 brands of 230.
//
// ── WHAT THIS TOOL WILL NOT DO ───────────────────────────────────────────────
//
// It will not tell you which brand an RN belongs to, because the register does
// not answer that question. It answers "which company registered this", and the
// gap between the two is where every trap in this corpus lives:
//
//   search=Vince   -> RN 100566  VINCENT-POWER INC  "LADIES CLOTHING"
//
// VINCENT-POWER INC is not the Vince label. Taking the first hit seeds an
// authoritative-looking lie — a real federal record, the right-looking string,
// and the wrong company. The same shape as RN 17257 (LONGCHAMP FABRICS CORP, a
// fabric wholesaler, not the maison) and RN 13765 (UNION UNDERWEAR, the parent,
// not Screen Stars). See vault/20-domain/brands/brand-kb-negative-findings.md.
//
// So this prints candidates for a HUMAN to match against the label. It never
// decides.
//
// Run:  node scripts/ops/ftc-rn-lookup.mjs Vuori Faherty "Eileen Fisher"
//       node scripts/ops/ftc-rn-lookup.mjs --json Vuori
//       node scripts/ops/ftc-rn-lookup.mjs --self-test

const SEARCH_URL = "https://www.ftc.gov/rn-database/search";
// The register 403s an obviously-scripted agent; this is a browser UA, not an
// attempt to get past anything that says no. The page itself is public.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";

/** Raised when the page came back but does not look like the register any more. */
export class UnrecognisedPage extends Error {
  constructor(message) {
    super(message);
    this.name = "UnrecognisedPage";
  }
}

const strip = (html) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    // The register emits SOME entities without their closing semicolon --
    // "WOMEN&#039 S APPAREL" is a real row. So the semicolon is optional
    // everywhere, and any numeric entity that survives is decoded generically
    // rather than needing its own line here.
    .replace(/&#0?39;?|&apos;?/g, "'")
    .replace(/&quot;?/g, '"')
    .replace(/&#8217;?|’/g, "'")
    .replace(/&#(\d+);?/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();

/**
 * Parse a results page into rows.
 *
 * ⚠ THE THROW IS THE WHOLE DESIGN. If the FTC changes its markup, a parser that
 * simply finds no rows reports "this brand has no RN" for EVERY brand, and that
 * is indistinguishable from the truth — you would seed nothing, conclude the
 * register was useless, and never know. So an unrecognised page is an ERROR, and
 * only a page that positively says "No results" is allowed to mean zero.
 */
export function parseResults(html) {
  const hasRows = html.includes("views-field-field-rn-no");
  const saysEmpty = /no results/i.test(html);
  if (!hasRows && !saysEmpty) {
    throw new UnrecognisedPage(
      "the page carries neither a result row nor a 'No results' message — " +
        "the register's markup has probably changed, and treating this as " +
        "'no RN' would be a silent false negative",
    );
  }
  if (!hasRows) return [];

  const body = html.slice(html.indexOf("<tbody"));
  const rows = [];
  for (const m of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) =>
      strip(c[1]),
    );
    if (cells.length < 3) continue;
    const [type, number, registrant, productLine = ""] = cells;
    if (!number) continue;
    rows.push({ type, number, registrant, productLine });
  }
  return rows;
}

async function lookup(query) {
  const url = `${SEARCH_URL}?search=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new UnrecognisedPage(`${url} answered HTTP ${res.status}`);
  }
  return parseResults(await res.text());
}

// ── fixtures ────────────────────────────────────────────────────────────────
// Trimmed from the real pages on 2026-09-06. Kept verbatim in shape so the
// self-test fails when the markup moves rather than when I paraphrase it.
const FIXTURE_HIT = `<table class="usa-table cols-4"><thead><tr>
<th class="views-field views-field-field-rn-type">Type</th>
<th class="views-field views-field-field-rn-no">No.</th>
<th class="views-field views-field-field-legal-business-name">Legal Business Name</th>
<th class="views-field views-field-field-rn-product-line">Product Line</th>
</tr></thead><tbody>
<tr><td class="views-field-field-rn-type">RN</td><td class="views-field-field-rn-no">140476</td>
<td class="views-field-field-legal-business-name">FAHERTY BRAND, LLC</td>
<td class="views-field-field-rn-product-line">CLOTHING</td></tr>
</tbody></table>`;
const FIXTURE_EMPTY = `<div class="view-empty"><p>No results</p></div>`;
const FIXTURE_MANGLED = `<html><body><h1>FTC</h1><p>Something else entirely.</p></body></html>`;

function selfTest() {
  const problems = [];

  const hit = parseResults(FIXTURE_HIT);
  if (hit.length !== 1) problems.push(`hit fixture parsed ${hit.length} rows, expected 1`);
  else {
    const r = hit[0];
    if (r.number !== "140476") problems.push(`number was ${r.number}`);
    if (r.registrant !== "FAHERTY BRAND, LLC") problems.push(`registrant was ${r.registrant}`);
    if (r.productLine !== "CLOTHING") problems.push(`productLine was ${r.productLine}`);
    if (r.type !== "RN") problems.push(`type was ${r.type}`);
  }

  const empty = parseResults(FIXTURE_EMPTY);
  if (empty.length !== 0) problems.push(`empty fixture parsed ${empty.length} rows, expected 0`);

  // The one that matters: a page we do not recognise must THROW, not return [].
  let threw = false;
  try {
    parseResults(FIXTURE_MANGLED);
  } catch (e) {
    threw = e instanceof UnrecognisedPage;
  }
  if (!threw) {
    problems.push(
      "a page with neither rows nor 'No results' did not throw — this is the " +
        "silent-false-negative case the parser exists to refuse",
    );
  }

  if (problems.length) {
    console.error("ftc-rn-lookup self-test FAILED:");
    for (const p of problems) console.error(`  ${p}`);
    return 1;
  }
  console.log("ftc-rn-lookup self-test: 3 fixtures OK (hit, empty, mangled-throws).");
  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) return selfTest();

  const asJson = args.includes("--json");
  const queries = args.filter((a) => !a.startsWith("--"));
  if (!queries.length) {
    console.error('usage: ftc-rn-lookup.mjs [--json] <brand or RN>...');
    return 2;
  }

  const out = [];
  for (const q of queries) {
    try {
      const rows = await lookup(q);
      out.push({ query: q, rows });
      if (!asJson) {
        if (!rows.length) {
          console.log(`${q}\n  NO RESULTS  (not evidence of a fake — plenty of real brands have no US registration)`);
        } else {
          console.log(q);
          for (const r of rows.slice(0, 6)) {
            console.log(`  ${r.type} ${r.number}  ${r.registrant}${r.productLine ? `  [${r.productLine}]` : ""}`);
          }
          if (rows.length > 6) console.log(`  ... ${rows.length - 6} more`);
        }
      }
    } catch (e) {
      // Never swallow this into "no results".
      console.error(`${q}\n  LOOKUP FAILED: ${e.message}`);
      out.push({ query: q, error: e.message });
    }
  }
  if (asJson) console.log(JSON.stringify(out, null, 2));

  // A failed lookup is an error; a legitimate empty result is not.
  return out.some((o) => o.error) ? 1 : 0;
}

main().then((c) => process.exit(c));
