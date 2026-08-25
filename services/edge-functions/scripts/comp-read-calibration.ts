// US-2842: the calibration spike. OPERATOR-RUN, founder only.
//
// THE QUESTION. We know what our own certified garments grade at, because we
// graded them from proper photos under the real pipeline. This re-reads those
// same garments from their LISTING photos, through the same public endpoint a
// comp read would use, and reports how far off the answer is. That gap is the
// error the whole condition-priced comps bet (US-2841) inherits.
//
// ⚠ THIS SPENDS REAL MONEY ON REAL AI CALLS. It refuses to do so without
// --confirm, prints the arithmetic first, and paces itself under the endpoint's
// own rate limit rather than around it.
//
// ⚠ IT PRODUCES NUMBERS, NOT A VERDICT. The story ends in a written GO or
// NO-GO, and that is the founder's to write. A threshold chosen by the person
// who wants the answer to be yes is not a gate.
//
// RATE LIMIT, STATED UP FRONT because it decides how long this takes.
// /grade-from-url allows 20 grades per IP per hour (EXT_GRADE_PER_IP_PER_HOUR).
// That is not raised or worked around here: the default pacing is one read
// every ~3.1 minutes, so 20 garments takes about an hour and a retest pass
// doubles it. Plan the run, or lower --limit.
//
// WHAT IT READS. Certified grade reports belonging to ONE owner by default,
// joined to the FlipDesk inventory item they came from and that item's public
// listing photos. Cross-tenant needs --all-tenants and is a deliberate choice,
// not a default: reading every seller's garments to calibrate our own reader is
// a different act from reading our own.
//
// WHAT IT PRINTS. Aggregates and an opaque ref per row. Never a user id, never a
// submission id, never a seller's name.
//
//   deno run --allow-net --allow-env scripts/comp-read-calibration.ts --owner <uuid> --dry-run
//   deno run --allow-net --allow-env scripts/comp-read-calibration.ts --owner <uuid> --limit 20 --confirm
//   deno run --allow-net --allow-env scripts/comp-read-calibration.ts --owner <uuid> --limit 20 --retest --confirm --out spike.json
//
// Env (exported by the operator, never read from a file here):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   the production database
//   CALIBRATION_EDGE_BASE_URL                 e.g. https://functions.gradethread.com
//   CALIBRATION_EXTENSION_TOKEN               optional; raises the per-call image cap

import { createClient } from "@supabase/supabase-js";
import {
  type BudgetRow,
  buildCandidates,
  type CalibrationCandidate,
  type CalibrationRead,
  costPerRead,
  explainNoCandidates,
  type ItemRow,
  type LinkRow,
  MAX_PHOTOS_PER_READ,
  type PhotoRow,
  type ReportRow,
  summarizeCalibration,
} from "../src/lib/comp-read-calibration.ts";

// ── arguments ───────────────────────────────────────────────────────

function flag(name: string): string | null {
  const i = Deno.args.indexOf(`--${name}`);
  return i >= 0 && Deno.args[i + 1] && !Deno.args[i + 1].startsWith("--")
    ? Deno.args[i + 1]
    : null;
}
function has(name: string): boolean {
  return Deno.args.includes(`--${name}`);
}
function intFlag(name: string, dflt: number): number {
  const raw = flag(name);
  if (raw == null) return dflt;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

const owner = flag("owner");
const allTenants = has("all-tenants");
const limit = intFlag("limit", 20);
const retest = has("retest");
const confirm = has("confirm");
const dryRun = has("dry-run");
// ~3.1 minutes. 19 reads an hour, just under the endpoint's 20-per-IP window.
const delayMs = intFlag("delay-ms", 185_000);
const outPath = flag("out");

if (!owner && !allTenants) {
  console.error(
    "Refusing to run: pass --owner <uuid> for your own garments, or --all-tenants " +
      "to read every seller's. There is no default, because those are different acts.",
  );
  Deno.exit(2);
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const EDGE_BASE = (Deno.env.get("CALIBRATION_EDGE_BASE_URL") ?? "").replace(/\/$/, "");
const EXT_TOKEN = Deno.env.get("CALIBRATION_EXTENSION_TOKEN") ?? "";

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  Deno.exit(2);
}
if (!EDGE_BASE) {
  console.error(
    "Set CALIBRATION_EDGE_BASE_URL to the EDGE host (functions.gradethread.com), " +
      "not the Supabase host. /api/* does not exist on api.gradethread.com.",
  );
  Deno.exit(2);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

// ── candidate selection ─────────────────────────────────────────────

type Candidate = CalibrationCandidate;

/** Opaque and stable, so a rerun pairs with a prior run without carrying an id. */
async function refOf(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed));
  return Array.from(new Uint8Array(digest))
    .slice(0, 6)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface LoadResult {
  candidates: Candidate[];
  /** Why there are none, when there are none. */
  why: string | null;
}

/**
 * Four reads, no decisions.
 *
 * Every judgement (which rows pair, which URLs are fetchable, what to say when
 * nothing matched) lives in lib/comp-read-calibration.ts, where it is unit
 * tested. This function only fetches, so the part of the spike that can be
 * wrong on a Tuesday is the part that is covered.
 */
async function loadCandidates(): Promise<LoadResult> {
  let q = db
    .from("grade_reports")
    .select("id, submission_id, overall_score, certificate_id, user_id")
    .not("certificate_id", "is", null)
    .not("overall_score", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit * 4);
  if (!allTenants && owner) q = q.eq("user_id", owner);

  const { data: reportData, error } = await q;
  if (error) throw new Error(`grade_reports read failed: ${error.message}`);
  const reports = (reportData ?? []) as ReportRow[];

  const submissionIds = reports.map((r) => r.submission_id).filter((s): s is string => !!s);
  let links: LinkRow[] = [];
  if (submissionIds.length > 0) {
    const { data, error: linkErr } = await db
      .from("flipdesk_grading_submissions")
      .select("inventory_item_id, submission_id")
      .in("submission_id", submissionIds);
    if (linkErr) throw new Error(`flipdesk_grading_submissions read failed: ${linkErr.message}`);
    links = (data ?? []) as LinkRow[];
  }

  const itemIds = [...new Set(links.map((l) => l.inventory_item_id))];
  let items: ItemRow[] = [];
  let photos: PhotoRow[] = [];
  if (itemIds.length > 0) {
    const { data: itemData, error: itemErr } = await db
      .from("inventory_items")
      .select("id, brand, title")
      .in("id", itemIds);
    if (itemErr) throw new Error(`inventory_items read failed: ${itemErr.message}`);
    items = (itemData ?? []) as ItemRow[];

    const { data: photoData, error: photoErr } = await db
      .from("item_photos")
      .select("inventory_item_id, photo_url, sort_order")
      .in("inventory_item_id", itemIds)
      .order("sort_order", { ascending: true });
    if (photoErr) throw new Error(`item_photos read failed: ${photoErr.message}`);
    photos = (photoData ?? []) as PhotoRow[];
  }

  // Hash the refs up front: buildCandidates is pure and takes a plain function.
  const refs = new Map<string, string>();
  for (const r of reports) refs.set(r.id, await refOf(r.id));

  const candidates = buildCandidates(
    reports,
    links,
    items,
    photos,
    limit,
    (id) => refs.get(id) ?? id.slice(0, 12),
  );
  return {
    candidates,
    why: candidates.length === 0 ? explainNoCandidates(reports, links, photos) : null,
  };
}

// ── the read ────────────────────────────────────────────────────────

interface ReadOutcome {
  score: number | null;
  confidence: number | null;
  imagesAnalyzed: number;
  error: string | null;
}

async function readOne(c: Candidate): Promise<ReadOutcome> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (EXT_TOKEN) headers["Authorization"] = `Bearer ${EXT_TOKEN}`;
  try {
    const res = await fetch(`${EDGE_BASE}/api/grading/public/grade-from-url`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        imageUrls: c.photoUrls,
        brand: c.brand ?? undefined,
        title: c.title ?? undefined,
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        score: null,
        confidence: null,
        imagesAnalyzed: 0,
        error: `HTTP ${res.status}: ${text.slice(0, 160)}`,
      };
    }
    const body = JSON.parse(text) as {
      overallScore?: number;
      confidence?: number;
      imagesAnalyzed?: number;
    };
    return {
      score: typeof body.overallScore === "number" ? body.overallScore : null,
      confidence: typeof body.confidence === "number" ? body.confidence : null,
      imagesAnalyzed: typeof body.imagesAnalyzed === "number" ? body.imagesAnalyzed : 0,
      error: null,
    };
  } catch (err) {
    return {
      score: null,
      confidence: null,
      imagesAnalyzed: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function budgetSnapshot(): Promise<BudgetRow[]> {
  const { data, error } = await db.rpc("ai_budget_status");
  if (error) {
    console.warn(`[spike] budget read failed (${error.message}); cost will be unavailable.`);
    return [];
  }
  const rows = Array.isArray(data) ? data : [];
  return rows.map((r) => ({
    feature: String((r as Record<string, unknown>).feature ?? ""),
    period: String((r as Record<string, unknown>).period ?? ""),
    spendUsd: Number((r as Record<string, unknown>).spendUsd ?? 0),
  }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── run ─────────────────────────────────────────────────────────────

const { candidates, why } = await loadCandidates();
const passes = retest ? 2 : 1;
const totalCalls = candidates.length * passes;
const etaMinutes = Math.round((totalCalls * delayMs) / 60_000);

console.log("");
console.log("US-2842 comp-read calibration");
console.log(`  scope         ${allTenants ? "ALL TENANTS" : `owner ${owner}`}`);
console.log(`  garments      ${candidates.length} (asked for ${limit})`);
console.log(`  passes        ${passes}${retest ? " (test-retest)" : ""}`);
console.log(`  AI calls      ${totalCalls}`);
console.log(`  pacing        ${Math.round(delayMs / 1000)}s between calls`);
console.log(`  estimated     ~${etaMinutes} minutes`);
console.log(`  endpoint      ${EDGE_BASE}/api/grading/public/grade-from-url`);
console.log("");

if (candidates.length === 0) {
  // Not "no candidates". WHICH of the three requirements failed, because that
  // is the difference between "we have no data" and "the join is wrong".
  console.error(`No candidates. ${why}`);
  console.error(
    "A garment qualifies only with a CERTIFIED grade report, a " +
      "flipdesk_grading_submissions row linking it to an inventory item, and at " +
      `least one http(s) listing photo (up to ${MAX_PHOTOS_PER_READ} are used).`,
  );
  Deno.exit(1);
}

if (dryRun) {
  console.log("Dry run. No AI calls made. Candidates:");
  for (const c of candidates) {
    console.log(
      `  ${c.ref}  certified ${c.certifiedScore.toFixed(1)}  ${c.photoUrls.length} photo(s)  ${
        (c.brand ?? "").slice(0, 20)
      }`,
    );
  }
  Deno.exit(0);
}

if (!confirm) {
  console.error(
    `Refusing to spend ${totalCalls} AI calls without --confirm. Re-run with --dry-run\n` +
      "first if you want to see what it would read.",
  );
  Deno.exit(2);
}

const before = await budgetSnapshot();
const reads: CalibrationRead[] = [];
let call = 0;

for (const c of candidates) {
  if (call > 0) await sleep(delayMs);
  call++;
  const first = await readOne(c);
  console.log(
    `[${call}/${totalCalls}] ${c.ref} certified ${c.certifiedScore.toFixed(1)} -> ${
      first.score == null ? `FAILED (${first.error})` : first.score.toFixed(1)
    }`,
  );

  let retestScore: number | null = null;
  if (retest) {
    await sleep(delayMs);
    call++;
    const second = await readOne(c);
    retestScore = second.score;
    console.log(
      `[${call}/${totalCalls}] ${c.ref} retest -> ${
        second.score == null ? `FAILED (${second.error})` : second.score.toFixed(1)
      }`,
    );
  }

  reads.push({
    ref: c.ref,
    certifiedScore: c.certifiedScore,
    readScore: first.score,
    readConfidence: first.confidence,
    imagesAnalyzed: first.imagesAnalyzed,
    retestScore,
    error: first.error,
  });
}

const after = await budgetSnapshot();
const summary = summarizeCalibration(reads);
const cost = costPerRead(before, after, call);

console.log("");
console.log("── RESULT ──────────────────────────────────────────────");
console.log(`attempted            ${summary.attempted}`);
console.log(`scored               ${summary.scored}`);
console.log(`failed               ${summary.failed}`);
console.log(`mean signed error    ${summary.meanSignedError ?? "n/a"}  (+ means reads run HIGH)`);
console.log(`mean absolute error  ${summary.meanAbsoluteError ?? "n/a"}`);
console.log(`median abs error     ${summary.medianAbsoluteError ?? "n/a"}`);
console.log(`within 0.5 point     ${summary.withinHalfPoint ?? "n/a"}`);
console.log(`within 1.0 point     ${summary.withinOnePoint ?? "n/a"}`);
console.log(`worst abs error      ${summary.worstAbsoluteError ?? "n/a"}`);
console.log(`test-retest pairs    ${summary.retestPairs}`);
console.log(`mean retest delta    ${summary.meanTestRetestDelta ?? "n/a"}  (the floor under the error above)`);
console.log(`max retest delta     ${summary.maxTestRetestDelta ?? "n/a"}`);
console.log(`mean images read     ${summary.meanImagesAnalyzed ?? "n/a"}`);
console.log(`mean read confidence ${summary.meanReadConfidence ?? "n/a"}`);
console.log("");
console.log("by grade band:");
for (const b of summary.byBand) {
  console.log(`  ${b.band.padEnd(22)} n=${String(b.n).padEnd(4)} signed ${b.meanSignedError}  abs ${b.meanAbsoluteError}`);
}
console.log("");
console.log(`dollars per read     ${cost.dollarsPerRead ?? "n/a"}  (${cost.spentUsd ?? "n/a"} USD over ${cost.reads} calls)`);
if (cost.caveat) console.log(`  caveat: ${cost.caveat}`);
console.log("");
console.log("No verdict is printed. US-2842 ends in a written GO or NO-GO, and that is yours.");

if (outPath) {
  await Deno.writeTextFile(
    outPath,
    JSON.stringify({ summary, cost, reads }, null, 2) + "\n",
  );
  console.log(`Wrote ${outPath}`);
}
