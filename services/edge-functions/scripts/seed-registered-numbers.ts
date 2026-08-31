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
//      along and nothing has ever resolved them. Step 2 searches by the brands
//      DECLARED alongside the sighting, so it can only resolve a number whose
//      owner someone already named.
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
// --dry-run is the default. Nothing writes without --apply.

import { supabaseAdmin } from "../src/lib/supabase.ts";
import {
  decideSeedRow,
  type FtcRnRecord,
  searchFtc,
} from "../src/lib/ftc-rn-search.ts";
import { registeredNumberKey } from "../src/lib/registered-numbers.ts";

/** Milliseconds between FTC requests. Deliberately not configurable. */
const PACE_MS = 2000;

interface Candidate {
  /** The term to search the registry for. */
  term: string;
  /** brand_knowledge.brand_key values this term stands for, if any. */
  brandKeys: string[];
  /** Where the candidate came from, for the summary line. */
  origin: "brand" | "sighting";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Brands we know, minus any that already have a registry row. */
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

/** Numbers seen on real tags that nothing has resolved yet, most-seen first. */
async function sightingCandidates(): Promise<Candidate[]> {
  const { data, error } = await supabaseAdmin
    .from("registered_number_sightings")
    .select("registry_key, sighting_count, resolved")
    .eq("resolved", false)
    .order("sighting_count", { ascending: false })
    .limit(500);
  if (error) throw new Error(`sightings read failed: ${error.message}`);

  const out: Candidate[] = [];
  for (const row of data ?? []) {
    // Searched by NUMBER rather than by declared brand. The registry answers a
    // number exactly, where a declared brand is whatever a seller typed, so the
    // number is both more precise and available for every sighting.
    const digits = String(row.registry_key).split(":")[1] ?? "";
    if (!digits) continue;
    out.push({ term: digits, brandKeys: [], origin: "sighting" });
  }
  return out;
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

async function main(): Promise<void> {
  const args = new Set(Deno.args);
  const apply = args.has("--apply");
  const limitArg = Deno.args.indexOf("--limit");
  const limit = limitArg >= 0 ? Number(Deno.args[limitArg + 1]) : Infinity;

  const known = await existingKeys();
  const candidates = [...await brandCandidates(), ...await sightingCandidates()];

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
      } else {
        written++;
        console.log(`[write] ${c.term}: ${key} ${decision.record.legalName}`);
        if (apply) await writeRow(decision.record, c.brandKeys);
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
