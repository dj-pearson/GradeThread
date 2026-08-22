// US-2694: how many style codes can the index actually NAME?
//
// Every story in this epic claims to improve identification. This is the number
// that says whether it did. Run it before a seeding run and after one; the
// difference is the payoff, measured rather than assumed.
//
// It counts three things that are easy to confuse:
//
//   SEEN      distinct (brand, code) pairs anywhere — items, observations,
//             sweeps. The denominator.
//   NAMED     codes with at least one unrejected row in style_code_names. What
//             a seller actually gets back.
//   BY SOURCE named codes split by which source won, because a code named only
//             by market consensus is a weaker answer than one a seller or the
//             brand named, and a single "coverage %" hides that entirely.
//
// Usage:
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/style-code-coverage.mjs
//   … --brand lululemon      restrict every count to one brand
//   … --json                 machine-readable, for diffing two runs

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const brandIdx = args.indexOf("--brand");
const brand = brandIdx !== -1 ? (args[brandIdx + 1] ?? "").trim() : "";

// Precedence must match lib/style-code-names.ts. Duplicated deliberately and
// narrowly: this is a Node operator script and that is Deno edge code, and a
// build step to share four strings would cost more than it saves. The test
// src/test/style-code-scripts.test.ts ("uses the same source precedence as
// the edge") fails if the two drift.
export const NAME_SOURCE_ORDER = ["official", "admin", "seller", "consensus", "public"];

/** Pick the winning source for one code's rows. Pure, exported for the test. */
export function winningSource(sources) {
  for (const s of NAME_SOURCE_ORDER) {
    if (sources.includes(s)) return s;
  }
  return null;
}

/** Uppercased, punctuation-stripped — must match normalizeStyleCode(). */
export function normalizeStyleCode(raw) {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function readAll(url, headers, path) {
  // PostgREST caps a response; page rather than silently truncate, because a
  // coverage number that stops at 1000 is worse than no coverage number.
  const pageSize = 1000;
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(
      `${url}/rest/v1/${path}${sep}limit=${pageSize}&offset=${offset}`,
      { headers },
    );
    if (!res.ok) {
      throw new Error(`${path} -> ${res.status} ${await res.text()}`);
    }
    const page = await res.json();
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      "[style-code-coverage] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required",
    );
    process.exit(1);
  }
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const brandFilter = brand ? `&brand_key=eq.${encodeURIComponent(brand)}` : "";

  const [names, observations, sweeps] = await Promise.all([
    readAll(url, headers, `style_code_names?select=brand_key,style_code_norm,source,rejected_at${brandFilter}`),
    readAll(url, headers, `style_code_observations?select=brand_key,style_code_norm${brandFilter}`),
    readAll(url, headers, `style_code_sweeps?select=brand_key,style_code_norm,titles_found${brandFilter}`),
  ]);

  const seen = new Set();
  const add = (r) => seen.add(`${r.brand_key}|${r.style_code_norm}`);
  observations.forEach(add);
  sweeps.forEach(add);
  names.forEach(add);

  const sourcesByCode = new Map();
  for (const row of names) {
    if (row.rejected_at) continue;
    const k = `${row.brand_key}|${row.style_code_norm}`;
    if (!sourcesByCode.has(k)) sourcesByCode.set(k, []);
    sourcesByCode.get(k).push(row.source);
  }

  const bySource = Object.fromEntries(NAME_SOURCE_ORDER.map((s) => [s, 0]));
  for (const sources of sourcesByCode.values()) {
    const winner = winningSource(sources);
    if (winner) bySource[winner]++;
  }

  // A code the sweep tried and got nothing for is a DIFFERENT problem from one
  // nobody has looked at, and conflating them makes the backlog look bigger
  // than the work.
  const triedAndEmpty = sweeps.filter(
    (s) => s.titles_found === 0 && !sourcesByCode.has(`${s.brand_key}|${s.style_code_norm}`),
  ).length;

  const report = {
    brand: brand || "(all)",
    seen: seen.size,
    named: sourcesByCode.size,
    coverage_pct: seen.size ? Math.round((sourcesByCode.size / seen.size) * 1000) / 10 : 0,
    by_source: bySource,
    swept_with_no_market_answer: triedAndEmpty,
    never_looked_at: Math.max(0, seen.size - sourcesByCode.size - triedAndEmpty),
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Style-code coverage — ${report.brand}`);
  console.log(`  seen           ${report.seen}`);
  console.log(`  named          ${report.named}  (${report.coverage_pct}%)`);
  for (const s of NAME_SOURCE_ORDER) {
    console.log(`    ${s.padEnd(10)} ${bySource[s]}`);
  }
  console.log(`  swept, market had nothing   ${report.swept_with_no_market_answer}`);
  console.log(`  never looked at             ${report.never_looked_at}`);
}

// Only run when invoked directly, so the test can import the pure helpers.
// Matched on the FILENAME rather than on import.meta.url: a file:// comparison
// is fragile on Windows (drive-letter casing, backslashes) and would silently
// turn this into a library that never runs.
if (
  process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/style-code-coverage.mjs")
) {
  main().catch((err) => {
    console.error("[style-code-coverage]", err.message);
    process.exit(1);
  });
}
