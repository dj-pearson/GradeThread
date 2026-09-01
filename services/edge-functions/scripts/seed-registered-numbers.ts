// US-9029: fill registered_number_registry from the FTC public RN search.
//
// The table has existed since migration 00502 and is nearly empty. Migration
// 00466 declined to seed registered numbers on the stated ground that the FTC
// database is auth-gated. It is not — see the header of lib/ftc-rn-search.ts —
// and that one wrong sentence is why six brands out of ~180 carry a number.
//
// ── WHAT IT DOES, IN ORDER ─────────────────────────────────────────────────
//
//   1. brand_knowledge, by name. These are the tags resellers actually hold.
//   2. registered_number_sightings that no registry row answers yet, most-seen
//      first. The product has been recording these off real garment tags all
//      along and nothing has ever resolved them. Step 2 searches by the NUMBER,
//      which the registry answers exactly, rather than by the brand a seller
//      happened to type alongside it.
//
// ── IT DRAINS THE QUEUE IT READS ───────────────────────────────────────────
//
// registered_number_sightings.resolved is the work queue 00501 built, and until
// US-9034 nothing but the admin resolve route ever set it. The bulk path — this
// script — left every row it answered sitting in the queue, so a second run
// re-searched all of them at one request per two seconds. That is the opposite
// of the politeness the pacing exists to buy, and it grows with every tag read.
//
// So: a candidate whose registry key is already resolved is dropped BEFORE a
// request is spent, and an --apply run flags the sighting it answered, keyed on
// the number the FTC actually returned rather than on the term searched. That
// is the same key the admin route uses (routes/admin-registered-numbers.ts), so
// both writers take a number off the queue the same way.
//
// Nothing else. No speculative import of the wider register: a row we cannot
// tie to a brand we know is a row nobody asked for.
//
// ── IT REFUSES TO GUESS ────────────────────────────────────────────────────
//
// decideSeedRow (lib/ftc-rn-search.ts) writes only on exactly one match.
// "Patagonia" returns two registrants, and picking either would put a wrong
// company under a page whose whole selling point is that it shows its sources.
// Ambiguous brands print as REVIEW and write nothing.
//
// ── PACING ─────────────────────────────────────────────────────────────────
//
// One request every two seconds, single threaded, and the run HALTS on any
// non-200. This is somebody else's public service and about 180 lookups is a
// rounding error at that rate. Do not parallelise it.
//
//   deno run --allow-net --allow-env scripts/seed-registered-numbers.ts --dry-run
//   deno run --allow-net --allow-env scripts/seed-registered-numbers.ts --dry-run --limit 5
//   deno run --allow-net --allow-env scripts/seed-registered-numbers.ts --apply
//
// --dry-run is the default. Nothing writes without --apply. Note that a DRY RUN
// still needs the database: it reads brand_knowledge and the sighting queue to
// decide what it WOULD search. Required env:
//
//   SUPABASE_URL                e.g. https://api.gradethread.com
//   SUPABASE_SERVICE_ROLE_KEY   (SUPABASE_SERVICE_KEY is accepted too)

import { supabaseAdmin } from "../src/lib/supabase.ts";
import {
  decideSeedRow,
  type FtcRnRecord,
  searchFtc,
} from "../src/lib/ftc-rn-search.ts";
import { registeredNumberKey } from "../src/lib/registered-numbers.ts";

/** Milliseconds between FTC requests. Deliberately not configurable. */
const PACE_MS = 2000;

export interface Candidate {
  /** The term to search the registry for. */
  term: string;
  /** brand_knowledge.brand_key values this term stands for, if any. */
  brandKeys: string[];
  /** Where the candidate came from, for the summary line. */
  origin: "brand" | "sighting";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Every brand we know, searched by name.
 *
 * Unfiltered on purpose, unlike the sighting queue: a brand carries no number
 * until the FTC answers, so there is nothing to compare against the registry
 * beforehand. The duplicate is caught after the search instead, and the row it
 * would have written is a `[have ]` line.
 */
async function brandCandidates(): Promise<Candidate[]> {
  // canonical_brand, not brand_name — the display name lives in that column
  // (see lib/registered-numbers.ts, which reads the same pair).
  const { data, error } = await supabaseAdmin
    .from("brand_knowledge")
    .select("brand_key, canonical_brand")
    .order("brand_key", { ascending: true });
  if (error) throw new Error(`brand_knowledge read failed: ${error.message}`);

  return (data ?? [])
    .filter((r) => String(r.canonical_brand ?? "").trim().length > 1)
    .map((r) => ({
      term: String(r.canonical_brand).trim(),
      brandKeys: [String(r.brand_key)],
      origin: "brand" as const,
    }));
}

/**
 * Turn queue rows into search candidates, dropping the ones the registry
 * already answers.
 *
 * Pure and exported so the drop rule has a test: it is the whole of US-9034,
 * and its failure mode is invisible — a run that re-searches settled numbers
 * looks exactly like a run that works, only slower and ruder.
 */
export function sightingCandidatesFrom(
  rows: ReadonlyArray<{ registry_key: unknown }>,
  known: ReadonlySet<string>,
): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const registryKey = String(row.registry_key ?? "");
    // A sighting IS its registry key, so unlike a brand we can tell before
    // searching whether the registry already answers it. A row can sit here
    // with resolved=false and a registry row present — every run before
    // US-9034 left exactly that behind — and re-searching it would spend two
    // seconds of somebody else's public service to learn what we already know.
    if (known.has(registryKey)) continue;
    if (seen.has(registryKey)) continue;

    // Searched by NUMBER rather than by declared brand. The registry answers a
    // number exactly, where a declared brand is whatever a seller typed, so the
    // number is both more precise and available for every sighting.
    const digits = registryKey.split(":")[1] ?? "";
    if (!digits) continue;
    seen.add(registryKey);
    out.push({ term: digits, brandKeys: [], origin: "sighting" });
  }
  return out;
}

/** Numbers seen on real tags that nothing has resolved yet, most-seen first. */
async function sightingCandidates(known: Set<string>): Promise<Candidate[]> {
  const { data, error } = await supabaseAdmin
    .from("registered_number_sightings")
    .select("registry_key, sighting_count, resolved")
    .eq("resolved", false)
    .order("sighting_count", { ascending: false })
    .limit(500);
  if (error) throw new Error(`sightings read failed: ${error.message}`);

  return sightingCandidatesFrom(data ?? [], known);
}

/** Registry keys already present, so a run never re-searches settled numbers. */
async function existingKeys(): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin
    .from("registered_number_registry")
    .select("registry_key");
  if (error) throw new Error(`registry read failed: ${error.message}`);
  return new Set((data ?? []).map((r) => String(r.registry_key)));
}

async function writeRow(record: FtcRnRecord, brandKeys: string[]): Promise<void> {
  const key = registeredNumberKey({ kind: record.kind, digits: record.digits });
  const { error } = await supabaseAdmin
    .from("registered_number_registry")
    .upsert(
      {
        registry_key: key,
        kind: record.kind,
        digits: record.digits,
        company_name: record.legalName,
        brand_keys: brandKeys,
        source_url: record.sourceUrl,
        notes: record.productLines.length > 0
          ? `FTC product lines: ${record.productLines.join(", ")}`
          : null,
        verified: true,
        resolved_by: "ftc-seed",
      },
      { onConflict: "registry_key" },
    );
  if (error) throw new Error(`upsert ${key} failed: ${error.message}`);
}

/**
 * Take a number off the sighting queue.
 *
 * Keyed on the number the FTC RETURNED, not on the term searched: a brand
 * candidate has no number until the search answers, and that answer may already
 * be sitting unresolved in the queue because someone photographed the tag
 * before we knew whose it was. Keying on the result resolves both origins.
 *
 * A miss is normal and silent — most registry rows come from brands nobody has
 * photographed yet. A failure is logged and does not halt the run: the registry
 * row is the deliverable and it is already written; the flag only saves the
 * next run a request.
 *
 * One .eq() and no .or() — US-1552: prod PostgREST rejects logical operators on
 * a mutation while the local stack accepts them, so CI cannot catch that.
 */
async function resolveSighting(registryKey: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("registered_number_sightings")
    .update({ resolved: true } as never)
    .eq("registry_key", registryKey);
  if (error) {
    console.error(`[warn ] ${registryKey}: registry row saved, queue flag failed: ${error.message}`);
  }
}

/**
 * Say what we need, before a transitive import says it for us.
 *
 * US-2661 made lib/supabase.ts build its client on first USE rather than at
 * import, so a script that never queries no longer dies on the import alone.
 * This one DOES query — the very first thing main() does is read the registry —
 * so without this check the failure surfaces from inside supabase.ts as
 * "SUPABASE_URL is not set", with a stack through existingKeys() and no hint
 * that a dry run needs a database at all. operator-scripts-start.test.mjs holds
 * every script in this directory to naming its own requirements.
 */
function requireDatabaseEnv(): void {
  const missing: string[] = [];
  if (!Deno.env.get("SUPABASE_URL")) missing.push("SUPABASE_URL");
  if (
    !Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") &&
    !Deno.env.get("SUPABASE_SERVICE_KEY")
  ) {
    missing.push("SUPABASE_SERVICE_ROLE_KEY");
  }
  if (missing.length === 0) return;

  console.error(
    `[seed] Missing env: ${missing.join(", ")}.\n` +
      "This script reads brand_knowledge and registered_number_sightings to " +
      "decide what to search, so it needs the database even for --dry-run.\n" +
      "  deno run --allow-net --allow-env scripts/seed-registered-numbers.ts --dry-run",
  );
  Deno.exit(1);
}

async function main(): Promise<void> {
  const args = new Set(Deno.args);
  const apply = args.has("--apply");
  const limitArg = Deno.args.indexOf("--limit");
  // A bare `--limit` used to become NaN, and `done >= NaN` is false, so the run
  // silently searched every candidate instead of the few the operator asked for.
  let limit = Infinity;
  if (limitArg >= 0) {
    limit = Number(Deno.args[limitArg + 1]);
    if (!Number.isFinite(limit) || limit < 1) {
      console.error("--limit needs a positive number, e.g. --limit 5");
      Deno.exit(2);
    }
  }

  requireDatabaseEnv();

  const known = await existingKeys();
  const candidates = [...await brandCandidates(), ...await sightingCandidates(known)];

  console.log(
    `[seed] ${candidates.length} candidate(s), ${known.size} registry row(s) already present. ` +
      `${apply ? "APPLYING" : "DRY RUN — nothing will be written"}.`,
  );

  let written = 0, review = 0, skipped = 0, done = 0;
  const reviews: string[] = [];

  for (const c of candidates) {
    if (done >= limit) break;
    done++;

    const results = await searchFtc(c.term);
    const decision = decideSeedRow(c.term, results);

    if (decision.action === "skip") {
      skipped++;
      console.log(`[skip ] ${c.term}: ${decision.reason}`);
    } else if (decision.action === "review") {
      review++;
      const names = decision.candidates
        .map((r) => `${r.kind} ${r.digits} ${r.legalName}`)
        .join(" | ");
      reviews.push(`${c.term}: ${names}`);
      console.log(`[REVIEW] ${c.term}: ${decision.reason} -> ${names}`);
    } else {
      const key = registeredNumberKey({
        kind: decision.record.kind,
        digits: decision.record.digits,
      });
      if (known.has(key)) {
        skipped++;
        console.log(`[have ] ${c.term}: ${key} already in the registry`);
        // The registry answers it, so the queue should not still be asking.
        // Reachable from a BRAND candidate whose number someone photographed
        // before we knew whose it was; sighting candidates are filtered out
        // above, before a request is spent.
        if (apply) await resolveSighting(key);
      } else {
        written++;
        console.log(`[write] ${c.term}: ${key} ${decision.record.legalName}`);
        if (apply) {
          await writeRow(decision.record, c.brandKeys);
          await resolveSighting(key);
        }
        known.add(key);
      }
    }

    await sleep(PACE_MS);
  }

  console.log(
    `\n[seed] searched ${done}, ${apply ? "wrote" : "would write"} ${written}, ` +
      `${review} need review, ${skipped} skipped.`,
  );
  if (reviews.length > 0) {
    console.log(
      `\n[seed] REVIEW QUEUE — resolve these by hand, the script will not guess:`,
    );
    for (const r of reviews) console.log(`  ${r}`);
  }
  if (!apply && written > 0) {
    console.log(`\n[seed] Re-run with --apply to write those ${written} row(s).`);
  }
}

if (import.meta.main) await main();
