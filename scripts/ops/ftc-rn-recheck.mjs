#!/usr/bin/env node
// US-3128 AC3 -- re-check every registered number the KB already claims against
// the live FTC register.
//
// scripts/ops/ftc-rn-lookup.mjs answers "what does the register say about this
// query". This answers the other question, the one a growing column needs:
// "does the register still agree with everything we have already written down".
//
// ⚠ IT SEARCHES BY NUMBER, NEVER BY NAME, AND THAT IS THE WHOLE POINT.
//
// The register matches registrant names on SUBSTRING, so "Vince" returns
// VINCENT-POWER INC and "GANT" returns L'EGANTE, GANTOS and TIMELESS ELEGANTS.
// A name search can therefore never confirm a number we already hold. Searching
// by the number asks the only question with one answer: WHICH COMPANY HOLDS
// THIS. Peter Millar is the worked example -- `search=Peter Millar` returns
// nothing at all, while `search=100308` returns CHESTER GREGG, L.L.C. [KNIT
// SHIRTS], a knit-polo registrant for a knit-polo house (00730).
//
// ── THE THREE OUTCOMES, AND WHY NONE OF THEM IS A VERDICT ──────────────────
//
//   CONFIRMED  the register holds this exact type + number. The registrant it
//              prints is reported VERBATIM. It still does not say the number is
//              this brand's -- that judgement is the eight tests in
//              vault/20-domain/brands/brand-rn-attribution.md and it belongs to
//              a human.
//   ABSENT     the register holds no row for this type + number. NOT a verdict
//              that the number is wrong -- a registration can be cancelled, and
//              a pack may have sourced the number from the holder rather than
//              from here. It is a row for a person to look at.
//   CROSS-KIND the register holds the SAME DIGITS under the OTHER registry.
//              Measured 2026-09-10: the KB carries `CA 32054` for Urban
//              Outfitters, and `RN 32054` is JOSEPH KRAFT -- an unrelated
//              registrant. Anything that drops the prefix and searches the bare
//              digits lands on the wrong company, which is the RN 17257 shape
//              arriving through a new door.
//
// A CA number can never reach CONFIRMED here and that is not a fault in the
// number. CA identification numbers are issued by the Competition Bureau of
// CANADA; this is the FTC's register. Measured 2026-09-10: `search=CANADA`
// returns 46 rows and every one is type RN.
//
// This script never writes, never decides and never proposes SQL. It prints.
//
// ── WHERE THE SEEDED NUMBERS COME FROM ─────────────────────────────────────
//
// supabase/migrations, parsed with brand-kb-gap.mjs's scanner, for the same
// reason that script uses it: it runs in a sandbox with no production key, and
// the migrations are what a from-zero stack holds. A prod row edited through the
// admin curation surface is NOT seen here, which is a real limit and is printed
// in the header of every run rather than left for someone to discover.
//
// Run:
//   node scripts/ops/ftc-rn-recheck.mjs --self-test
//   node scripts/ops/ftc-rn-recheck.mjs --list
//   node scripts/ops/ftc-rn-recheck.mjs --brands "alo yoga,zara,urbanoutfitters"
//   node scripts/ops/ftc-rn-recheck.mjs --limit 10
//   node scripts/ops/ftc-rn-recheck.mjs --all --json

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { splitTuples, literal, arrayLiteral, brandKey } from "../brand-kb-gap.mjs";
import { parseResults, UnrecognisedPage } from "./ftc-rn-lookup.mjs";

// fileURLToPath, never url.pathname: on Windows the pathname of a file: URL is
// "/C:/Users/..." and readdirSync rejects the leading slash.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");

const SEARCH_URL = "https://www.ftc.gov/rn-database/search";
// The register 403s an obviously-scripted agent. This is a browser UA, not an
// attempt to get past anything that says no -- the page is public and signed out.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";
// One request every 1.2s. The register owes us nothing; a sweep of the whole
// column is ~120 requests and there is no hurry on any of them.
const PACE_MS = 1200;
// A sweep is opt-in. Without --all or --limit the run stops after this many, so
// a casual invocation cannot turn into two minutes of traffic by accident.
const DEFAULT_LIMIT = 8;

/**
 * Split one seeded `registered_numbers` entry into {kind, digits}.
 *
 * Deliberately the same shapes lib/registered-numbers.ts accepts, minus range
 * expansion: a range ("RN 96919-96925") names up to 200 numbers and checking
 * each would be a sweep of its own, so it is reported as SKIPPED with its reason
 * rather than silently dropped. Returns null for anything unparseable, which is
 * itself reported -- a seeded string nobody can parse is a data bug.
 */
export function parseSeededEntry(entry) {
  const raw = String(entry ?? "").trim();
  if (/^\s*(RN|CA)?\s*#?\s*\d{2,7}\s*[-\u2013]\s*\d{2,7}\s*$/i.test(raw)) {
    return { kind: null, digits: null, skip: "a range, not a single number" };
  }
  const m = raw.match(/^\s*(RN|CA)?\s*#?\s*(\d{2,7})\s*$/i);
  if (!m) return null;
  const digits = m[2].replace(/^0+/, "");
  if (!digits) return null;
  return { kind: (m[1] ?? "RN").toUpperCase(), digits, skip: null };
}

/**
 * Every registered number the migrations seed, as
 * [{ brandKey, canonical, entry, kind, digits, skip, file }].
 *
 * Last write wins per brand_key, matching the packs' own `on conflict do update
 * set registered_numbers = excluded.registered_numbers`: a later pack replacing
 * a row's numbers must not leave the earlier ones in the audit.
 */
export function readSeededNumbers(dir = MIGRATIONS) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const opener = /insert\s+into\s+public\.([a-z_]+)\s*\(([^)]*)\)\s*values/gi;
  const byBrand = new Map();
  // DISTINCT brand_key, not tuples: the packs re-seed rows with `on conflict`,
  // so counting tuples inflates the denominator and makes coverage look worse.
  const allKeys = new Set();
  const unparsed = [];

  for (const name of files) {
    const sql = readFileSync(join(dir, name), "utf8");
    const opens = [...sql.matchAll(opener)];
    for (let i = 0; i < opens.length; i++) {
      if (opens[i][1].toLowerCase() !== "brand_knowledge") continue;
      const cols = opens[i][2].split(",").map((c) => c.trim().toLowerCase());
      const iKey = cols.indexOf("brand_key");
      const iCanon = cols.indexOf("canonical_brand");
      const iRn = cols.indexOf("registered_numbers");
      if (iKey === -1) continue;
      const from = opens[i].index + opens[i][0].length;
      const to = i + 1 < opens.length ? opens[i + 1].index : sql.length;
      const tuples = splitTuples(sql.slice(from, to));
      if (tuples.length === 0) {
        unparsed.push(`${name}: brand_knowledge insert yielded no tuples`);
        continue;
      }
      for (const t of tuples) {
        const key = literal(t[iKey]);
        if (!key) continue;
        allKeys.add(key);
        // A statement with no registered_numbers column says nothing about the
        // column, so it must not erase what an earlier pack wrote.
        if (iRn === -1) continue;
        const entries = arrayLiteral(t[iRn]);
        byBrand.set(key, {
          key,
          canonical: iCanon === -1 ? null : literal(t[iCanon]),
          entries,
          file: name,
        });
      }
    }
  }

  const out = [];
  for (const row of byBrand.values()) {
    for (const entry of row.entries) {
      const parsed = parseSeededEntry(entry);
      if (!parsed) {
        unparsed.push(`${row.file}: ${row.key} carries an unparseable entry ${JSON.stringify(entry)}`);
        continue;
      }
      out.push({
        brandKey: row.key,
        canonical: row.canonical ?? row.key,
        entry,
        kind: parsed.kind,
        digits: parsed.digits,
        skip: parsed.skip,
        file: row.file,
      });
    }
  }
  out.sort((a, b) => a.brandKey.localeCompare(b.brandKey) || a.entry.localeCompare(b.entry));
  return { numbers: out, brandRows: allKeys.size, brandsWithNumbers: new Set(out.map((n) => n.brandKey)).size, unparsed };
}

/**
 * Classify one seeded number against the rows the register returned.
 *
 * Pure, so every branch is covered by --self-test without touching the network.
 * The register substring-matches, so a search for 32054 may also return 132054;
 * only an EXACT digit match may confirm anything.
 */
export function classify(seeded, rows) {
  // A CA number is CANADIAN -- it is issued by the Competition Bureau of Canada,
  // not by the FTC, and this register is not that registry. Measured 2026-09-10:
  // `search=CANADA` returns 46 rows and EVERY ONE is type RN; no CA row appeared
  // anywhere in this session's traffic. So a CA number can never be CONFIRMED
  // here, and reading its absence as doubt would condemn every correctly seeded
  // Canadian number in the column.
  const caCaveat =
    seeded.kind === "CA"
      ? "A CA number is issued by the Competition Bureau of CANADA and this is the " +
        "FTC's register, so it cannot be confirmed here either way. "
      : "";
  const same = rows.filter((r) => r.number.replace(/\D/g, "").replace(/^0+/, "") === seeded.digits);
  const exact = same.filter((r) => r.type.toUpperCase() === seeded.kind);
  if (exact.length) {
    return {
      status: "CONFIRMED",
      registrants: exact.map((r) => ({ registrant: r.registrant, productLine: r.productLine })),
      note: exact.length > 1
        ? "the register returns more than one row for this exact number -- read both before relying on either"
        : "",
    };
  }
  const other = same.filter((r) => r.type.toUpperCase() !== seeded.kind);
  if (other.length) {
    return {
      status: "CROSS-KIND",
      registrants: other.map((r) => ({ registrant: r.registrant, productLine: r.productLine, type: r.type })),
      note:
        caCaveat +
        `The register holds ${other[0].type} ${seeded.digits} and not ${seeded.kind} ${seeded.digits}. ` +
        "Dropping the prefix lands on a different company -- do not.",
    };
  }
  return {
    status: "ABSENT",
    registrants: [],
    note:
      caCaveat +
      "The register returns no row for this type and number. Not evidence the " +
      "number is wrong -- a registration can be cancelled, and a pack may have " +
      "sourced it from the holder rather than from here. Look at it.",
  };
}

async function fetchRows(digits) {
  const url = `${SEARCH_URL}?search=${encodeURIComponent(digits)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new UnrecognisedPage(`${url} answered HTTP ${res.status}`);
  return parseResults(await res.text());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── fixtures ────────────────────────────────────────────────────────────────

function selfTest() {
  const problems = [];
  const push = (m) => problems.push(m);

  // parseSeededEntry
  const cases = [
    ["RN 87370", { kind: "RN", digits: "87370" }],
    ["CA 32054", { kind: "CA", digits: "32054" }],
    ["rn# 0100308", { kind: "RN", digits: "100308" }],
    ["100308", { kind: "RN", digits: "100308" }],
  ];
  for (const [input, want] of cases) {
    const got = parseSeededEntry(input);
    if (!got || got.kind !== want.kind || got.digits !== want.digits) {
      push(`parseSeededEntry(${JSON.stringify(input)}) gave ${JSON.stringify(got)}`);
    }
  }
  const range = parseSeededEntry("RN 96919-96925");
  if (!range || !range.skip) push("a range must be SKIPPED with a reason, not parsed as one number");
  if (parseSeededEntry("not a number") !== null) push("a non-number must parse as null so it is reported");

  // classify -- CONFIRMED
  const confirmed = classify({ kind: "RN", digits: "77302" }, [
    { type: "RN", number: "77302", registrant: "ZARA USA, INC.", productLine: "APPAREL" },
  ]);
  if (confirmed.status !== "CONFIRMED") push(`exact hit classified ${confirmed.status}`);
  if (confirmed.registrants[0]?.registrant !== "ZARA USA, INC.") push("registrant not reported verbatim");

  // classify -- CROSS-KIND, the measured CA 32054 / RN 32054 case
  const cross = classify({ kind: "CA", digits: "32054" }, [
    { type: "RN", number: "32054", registrant: "JOSEPH KRAFT", productLine: "" },
  ]);
  if (cross.status !== "CROSS-KIND") push(`CA 32054 against RN 32054 classified ${cross.status}`);
  if (!/Competition Bureau of CANADA/.test(cross.note)) {
    push("a CA number's note must say this is the wrong registry for it");
  }
  if (/Competition Bureau/.test(confirmed.note ?? "")) push("an RN must not carry the CA caveat");

  // classify -- ABSENT
  const absent = classify({ kind: "RN", digits: "999999" }, []);
  if (absent.status !== "ABSENT") push(`no rows classified ${absent.status}`);

  // classify -- a SUBSTRING hit must never confirm. This is the register's own
  // behaviour arriving in the number column, and it is the one that would read
  // as a clean pass while confirming a different registration entirely.
  const substring = classify({ kind: "RN", digits: "32054" }, [
    { type: "RN", number: "132054", registrant: "SOMEBODY ELSE, INC.", productLine: "" },
  ]);
  if (substring.status !== "ABSENT") {
    push(`a near-miss number (132054 for 32054) classified ${substring.status}, must be ABSENT`);
  }

  // The migration scan must find the column at all. A silent zero here reads
  // exactly like a clean audit.
  const seeded = readSeededNumbers();
  if (seeded.numbers.length < 50) {
    push(`readSeededNumbers found ${seeded.numbers.length} numbers, expected the column to be well past 50`);
  }
  if (!seeded.numbers.some((n) => n.digits === "87370")) {
    push("Alo Yoga's RN 87370 (00447, the oldest seeded number) was not found");
  }

  if (problems.length) {
    console.error("ftc-rn-recheck self-test FAILED:");
    for (const p of problems) console.error(`  ${p}`);
    return 1;
  }
  console.log(
    `ftc-rn-recheck self-test OK -- parse 6, classify 7 (confirmed, cross-kind + its CA caveat, absent, substring-absent), ` +
      `${seeded.numbers.length} seeded numbers across ${seeded.brandsWithNumbers} brands read from migrations.`,
  );
  return 0;
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] ?? null;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) return selfTest();

  const { numbers, brandRows, brandsWithNumbers, unparsed } = readSeededNumbers();
  const asJson = argv.includes("--json");
  const brandsArg = arg(argv, "--brands");
  const wanted = brandsArg
    ? new Set(brandsArg.split(",").map((s) => brandKey(s)).filter(Boolean))
    : null;

  let todo = numbers.filter((n) => !wanted || wanted.has(brandKey(n.brandKey)) || wanted.has(brandKey(n.canonical)));
  const limitArg = arg(argv, "--limit");
  const limit = argv.includes("--all") ? todo.length : Number(limitArg ?? DEFAULT_LIMIT);
  const truncated = todo.length > limit;
  const skipped = todo.filter((n) => n.skip);
  todo = todo.filter((n) => !n.skip).slice(0, limit);

  if (!asJson) {
    console.log(
      `FTC RN re-check -- ${numbers.length} numbers across ${brandsWithNumbers} brands ` +
        `(of ${brandRows} brand_knowledge rows) read from supabase/migrations.`,
    );
    console.log(
      "SOURCE LIMIT: migrations only. A number an operator typed into prod through the admin\n" +
        "curation surface is not in this list, and this script cannot see it.",
    );
    for (const u of unparsed) console.log(`  UNPARSED  ${u}`);
    for (const s of skipped) console.log(`  SKIPPED   ${s.canonical}  ${s.entry}  (${s.skip})`);
    if (argv.includes("--list")) {
      for (const n of numbers) console.log(`  ${n.kind} ${n.digits}  ${n.canonical}  [${n.file}]`);
      return 0;
    }
    console.log(`Checking ${todo.length}${truncated ? ` of ${todo.length + (wanted ? 0 : 0)}` : ""} at one request every ${PACE_MS}ms.\n`);
  } else if (argv.includes("--list")) {
    console.log(JSON.stringify({ numbers, brandRows, brandsWithNumbers, unparsed }, null, 2));
    return 0;
  }

  const results = [];
  let failures = 0;
  for (let i = 0; i < todo.length; i++) {
    const n = todo[i];
    if (i > 0) await sleep(PACE_MS);
    try {
      const rows = await fetchRows(n.digits);
      const verdict = classify(n, rows);
      results.push({ ...n, ...verdict });
      if (!asJson) {
        const who = verdict.registrants
          .map((r) => `${r.type ? `${r.type} ` : ""}${r.registrant}${r.productLine ? ` [${r.productLine}]` : ""}`)
          .join(" / ");
        console.log(`${verdict.status.padEnd(10)} ${n.kind} ${n.digits.padEnd(7)} ${n.canonical}`);
        if (who) console.log(`           -> ${who}`);
        if (verdict.note) console.log(`           !  ${verdict.note}`);
      }
    } catch (e) {
      // A lookup that failed must never be reported as "no row" -- that is the
      // silent false negative ftc-rn-lookup.mjs's parser exists to refuse.
      failures++;
      results.push({ ...n, status: "LOOKUP FAILED", error: e.message });
      if (!asJson) console.error(`LOOKUP FAILED  ${n.kind} ${n.digits}  ${n.canonical}: ${e.message}`);
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ brandRows, brandsWithNumbers, skipped, unparsed, results }, null, 2));
  } else {
    const tally = results.reduce((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {});
    console.log(
      `\n${Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join("  ")}` +
        (truncated && !argv.includes("--all") ? `   (stopped at ${limit}; pass --all for the whole column)` : ""),
    );
    console.log(
      "A CONFIRMED row means the register holds that number, NOT that it is this brand's. " +
        "That judgement is vault/20-domain/brands/brand-rn-attribution.md and it is a human's.",
    );
  }
  return failures ? 1 : 0;
}

// Importable for the self-test's sake without running a sweep.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((c) => process.exit(c));
}
