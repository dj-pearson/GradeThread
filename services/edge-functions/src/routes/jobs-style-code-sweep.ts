// US-2690: fill the learned style-code index at API speed instead of at seller
// speed.
//
// US-2246 learns a code the moment a seller photographs a tag we have not seen.
// That is one code per new garment, and the codes worth knowing are the ones
// nobody has listed yet. This tick takes the codes we have ALREADY seen but
// cannot yet name, asks eBay what the market calls them, and keeps the answer.
//
// MOST OF A TICK IS DECIDING WHAT NOT TO ASK. buildSweepWorkList drops codes
// already confirmed, codes still cooling off from a previous miss, and codes too
// short to be an identity — then the budget takes the top slice and the rest are
// reported as deferred, never silently truncated.
//
// Sequential on purpose: these are calls against the same app-level eBay budget
// the comps and identification paths share, and a fan-out here is how one tick
// starves a seller's Add flow.

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { brandKey } from "../lib/brand-normalize.ts";
import { searchBrowseComps } from "../lib/ebay-client.ts";
import { consensusStyleName } from "../lib/style-code-consensus.ts";
import { recordStyleCodeObservations } from "../lib/style-code-observations.ts";
import {
  buildSweepWorkList,
  DEFAULT_CODES_PER_RUN,
  type ObservationCountRow,
  type SweepCandidate,
  type SweepDeps,
  type SweepHit,
  type SweepOutcome,
  type SweepSourceRow,
  type SweepStateRow,
  sweepOneCode,
  summarizeSweep,
} from "../lib/style-code-sweep.ts";

/** Rows pulled from the observation/sweep tables per tick. Far larger than the
 *  sweep budget on purpose — most candidates are filtered out before the budget
 *  applies, so a scan the size of the budget would starve the work-list. */
const SCAN_LIMIT = 5000;

/** Distinct (brand, code) pairs the item RPC may return. Effectively "all of
 *  them" for a long time; the warning below fires if that stops being true. */
const ITEM_CODE_SCAN_CAP = 20_000;

/** How long one tick may hold the lock. Generous: the budget bounds the work,
 *  and a lock that expires mid-tick lets a second worker duplicate eBay calls. */
const LOCK_TTL_SECONDS = 1800;

/** Titles asked of eBay per code. The observation writer caps what it KEEPS at
 *  MAX_TITLES_PER_OBSERVATION; a wider read is what makes a consensus possible
 *  later (US-2691) without a second call. */
const TITLES_PER_CODE = 25;

function sweepBudget(): number {
  const raw = Deno.env.get("STYLE_CODE_SWEEP_BUDGET");
  if (!raw) return DEFAULT_CODES_PER_RUN;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_CODES_PER_RUN;
}

/**
 * Codes seen on seller items, as DISTINCT (brand, code) pairs from the 00627
 * RPC rather than a row scan deduped here.
 *
 * That is not a micro-optimization. US-2029 paid for the row-scan version on
 * this exact table: a cap on ROWS means one seller with a large recent catalog
 * starves every other seller out of the scan, and the job still reports success.
 * The cap has to bound the thing the budget is spent on, which is codes.
 *
 * NOT tenant-scoped, and deliberately: it reads a BRAND and a CODE printed on a
 * garment tag, which is manufacturer reference data rather than anyone's
 * business. No owner id, no title, no price and no photo leaves the query, and
 * nothing it produces is written back to an item — the sweep's only output is a
 * row in the non-tenant learned index.
 */
async function scanItemCodes(): Promise<SweepSourceRow[]> {
  const { data, error } = await supabaseAdmin.rpc("style_code_sweep_candidates", {
    p_limit: ITEM_CODE_SCAN_CAP,
  });
  if (error) {
    console.error("[style-code-sweep] item scan failed:", error.message);
    return [];
  }
  const rows = (data ?? []) as Array<{ brand: string | null; style_code: string }>;
  if (rows.length >= ITEM_CODE_SCAN_CAP) {
    // Say it. A bound that binds is the point at which "we considered every
    // code" stops being true, and nothing else in the output would show it.
    console.warn(
      `[style-code-sweep] item scan hit the ${ITEM_CODE_SCAN_CAP} cap — ` +
        "some codes were not considered this tick; raise the cap",
    );
  }
  return rows
    .filter((r) => typeof r.style_code === "string" && r.style_code.trim() !== "")
    .map((r) => ({
      brandKey: r.brand ? brandKey(r.brand) : "",
      brandLabel: r.brand ?? "",
      styleCodeRaw: r.style_code,
    }));
}

/** Codes already in the index but short of a confident answer. */
async function scanObservationCodes(): Promise<{
  seen: SweepSourceRow[];
  counts: ObservationCountRow[];
}> {
  const { data, error } = await supabaseAdmin
    .from("style_code_observations")
    .select("brand_key, style_code_norm, style_code_raw, seen_count")
    .order("seen_count", { ascending: true })
    .limit(SCAN_LIMIT);
  if (error) {
    console.error("[style-code-sweep] observation scan failed:", error.message);
    return { seen: [], counts: [] };
  }
  const rows = (data ?? []) as Array<{
    brand_key: string;
    style_code_norm: string;
    style_code_raw: string;
    seen_count: number;
  }>;
  return {
    seen: rows.map((r) => ({
      brandKey: r.brand_key,
      styleCodeRaw: r.style_code_raw || r.style_code_norm,
    })),
    counts: rows.map((r) => ({
      brand_key: r.brand_key,
      style_code_norm: r.style_code_norm,
      seen_count: r.seen_count,
    })),
  };
}

async function scanSweepState(): Promise<SweepStateRow[]> {
  const { data, error } = await supabaseAdmin
    .from("style_code_sweeps")
    .select("brand_key, style_code_norm, titles_found, last_swept_at")
    .limit(SCAN_LIMIT * 4);
  if (error) {
    console.error("[style-code-sweep] sweep-state scan failed:", error.message);
    // An empty state reads as "nothing swept yet", which re-asks codes rather
    // than skipping them. Wasteful, never wrong — and the alternative would
    // silently sweep a code twice in one tick.
    return [];
  }
  return (data ?? []) as SweepStateRow[];
}

const liveDeps: SweepDeps = {
  search: async (candidate: SweepCandidate): Promise<SweepHit[]> => {
    const res = await searchBrowseComps({
      // styleCode (US-2245) is searched VERBATIM — buildCompKeywords' de-noising
      // is bypassed for it, and losing one character of a code turns an
      // exact-product match into nothing.
      styleCode: candidate.styleCodeRaw,
      brand: candidate.brandLabel || undefined,
      limit: TITLES_PER_CODE,
    });
    return (res.items ?? [])
      .filter((i) => i.title !== "")
      .map((i) => ({ title: i.title, url: i.itemWebUrl ?? null }));
  },
  observe: (candidate, hits) =>
    recordStyleCodeObservations({
      brandKey: candidate.brandKey,
      styleCodeRaw: candidate.styleCodeRaw,
      titles: hits,
      source: "market_verify",
    }),
  resolveName: async (candidate, hits) => {
    // US-2691: null is the common answer early on and is not an error — a code
    // with two listings has no consensus, and inventing one would put a name on
    // a listing that no seller and no decoder ever supported.
    const consensus = consensusStyleName({
      titles: hits.map((h) => h.title),
      brand: candidate.brandLabel,
      styleCode: candidate.styleCodeRaw,
    });
    if (!consensus) return;
    const { error } = await supabaseAdmin.rpc("record_style_code_name", {
      p_brand_key: candidate.brandKey,
      p_style_code_norm: candidate.styleCodeNorm,
      p_style_code_raw: candidate.styleCodeRaw,
      p_name: consensus.name,
      p_source: "consensus",
      p_supporting: consensus.supporting,
      p_confidence: consensus.confidence,
      p_evidence_url: hits.find((h) => h.url)?.url ?? null,
    });
    if (error) throw error;
  },
  markSwept: async (candidate, titlesFound) => {
    const { error } = await supabaseAdmin.rpc("record_style_code_sweep", {
      p_brand_key: candidate.brandKey,
      p_style_code_norm: candidate.styleCodeNorm,
      p_style_code_raw: candidate.styleCodeRaw,
      p_titles_found: titlesFound,
    });
    if (error) throw error;
  },
};

/** The lock is a seam so the concurrency guarantee is a test, not a claim. */
export type LockAcquirer = typeof acquireJobLock;

export async function handleStyleCodeSweepCron(
  c: Context,
  deps: SweepDeps = liveDeps,
  acquire: LockAcquirer = acquireJobLock,
): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // A second tick that arrives while the first is still running must do NOTHING
  // — not a smaller sweep, not a retry. Both would spend the shared eBay budget
  // on codes the running tick has already claimed from the same derived list.
  const lock = await acquire("style-code-sweep", LOCK_TTL_SECONDS);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }

  try {
    const [itemCodes, observed, sweeps] = await Promise.all([
      scanItemCodes(),
      scanObservationCodes(),
      scanSweepState(),
    ]);

    const work = buildSweepWorkList({
      seen: [...itemCodes, ...observed.seen],
      observations: observed.counts,
      sweeps,
      budget: sweepBudget(),
      now: new Date(),
    });

    const outcomes: SweepOutcome[] = [];
    for (const candidate of work.candidates) {
      outcomes.push(await sweepOneCode(candidate, deps));
    }

    // Say what was left behind. A sweep that reports only what it did reads as
    // "we covered everything" on a run that covered a hundredth of the backlog.
    console.log(
      `[style-code-sweep] considered=${work.considered} swept=${work.candidates.length} ` +
        `deferred=${work.deferred} skipped_confirmed=${work.skippedConfirmed} ` +
        `skipped_cooldown=${work.skippedCooldown} skipped_short=${work.skippedTooShort}`,
    );

    return c.json({
      ok: true,
      considered: work.considered,
      swept: work.candidates.length,
      deferred: work.deferred,
      skipped_confirmed: work.skippedConfirmed,
      skipped_cooldown: work.skippedCooldown,
      skipped_short: work.skippedTooShort,
      ...summarizeSweep(outcomes),
    });
  } finally {
    await lock.release();
  }
}
