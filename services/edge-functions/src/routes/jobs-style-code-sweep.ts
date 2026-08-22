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
import { brandKeyForRaw } from "../lib/brand-normalize.ts";
import { getBrowseItemAspects, searchBrowseComps } from "../lib/ebay-client.ts";
import { canonicalStyleCode } from "../lib/style-code-observations.ts";
import {
  aspectEvidence,
  aspectNameConfidence,
  classifyListing,
  type ClassifiedListing,
} from "../lib/style-code-aspects.ts";
import {
  planRekey,
  type RekeyRow,
  summarizeRekey,
} from "../lib/style-code-rekey.ts";
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

/** How many of a code's listings get their ITEM SPECIFICS read.
 *
 *  US-2751: the Browse search response does not carry item specifics, so each
 *  one costs a second call. Bounded because the budget is shared with the Add
 *  flow and the comps ladder — and because a code whose first few listings all
 *  declare the same code is not made truer by a fourth. */
const ASPECT_LOOKUPS_PER_CODE = 6;

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
      // US-2692: canonicalize before keying — see identification-verify.ts.
      brandKey: brandKeyForRaw(r.brand) ?? "",
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

/**
 * US-2714: move rows the SQL trigger filed under a non-canonical key.
 *
 * Every TypeScript writer files a code under canonicalStyleCode. The 00629
 * trigger cannot — plpgsql has no decoder to ask — so a seller correcting a
 * garment whose tag reads LW6AMYSP60417 writes that key while every reader asks
 * for W6AMYS. Not lost, filed where nobody looks. This tick puts it back.
 *
 * Never throws: a reconcile failure must not cost the sweep its whole tick.
 */
async function reconcileKeys(): Promise<
  ReturnType<typeof summarizeRekey> & { failed: number }
> {
  const empty = { moved: 0, dropped: 0, conflicts: 0, correct: 0, failed: 0 };
  const { data, error } = await supabaseAdmin
    .from("style_code_names")
    .select(
      "id, brand_key, style_code_norm, style_code_raw, name, source, supporting, confidence, evidence_url, rejected_at",
    )
    .is("rejected_at", null)
    .limit(SCAN_LIMIT);
  if (error) {
    console.error("[style-code-sweep] rekey read failed:", error.message);
    return empty;
  }

  const plan = planRekey((data ?? []) as RekeyRow[]);
  let failed = 0;
  for (const step of plan.steps) {
    // A conflict is a DECISION, not a write. Two different first-party answers
    // for one garment need a human, and the admin queue already surfaces
    // exactly that — merging here would silently pick a winner.
    if (step.action === "conflict") continue;
    try {
      if (step.action === "move") {
        const { error: writeErr } = await supabaseAdmin.rpc(
          "record_style_code_name",
          {
            p_brand_key: step.row.brand_key,
            p_style_code_norm: step.canonical,
            p_style_code_raw: step.row.style_code_raw,
            p_name: step.row.name,
            p_source: step.row.source,
            p_supporting: step.row.supporting,
            p_confidence: step.row.confidence,
            p_evidence_url: step.row.evidence_url,
          },
        );
        if (writeErr) throw writeErr;
      }
      // Written at the canonical key (or already there), so the mis-keyed row
      // is one nothing reads and it goes. Deleted AFTER the write, never
      // before: a crash between the two leaves a duplicate, which the next tick
      // resolves as drop_duplicate. The other order would lose the answer.
      const { error: delErr } = await supabaseAdmin
        .from("style_code_names")
        .delete()
        .eq("id", step.row.id);
      if (delErr) throw delErr;
    } catch (err) {
      failed++;
      console.error(
        `[style-code-sweep] rekey ${step.row.style_code_norm} -> ${step.canonical} failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return { ...summarizeRekey(plan), failed };
}

/**
 * US-2751: our OWN eBay listings, so the sweep cannot learn our guesses back.
 *
 * Our sellers publish with titles and specifics our AI wrote. Counting those as
 * independent market confirmation is three copies of one guess wearing three
 * hats — and the consensus threshold does nothing about it, because the copies
 * genuinely agree.
 *
 * Read once per tick, not per code. A read failure returns an EMPTY set, which
 * fails toward counting our own listings rather than toward skipping the tick;
 * the alternative is a sweep that stops working whenever this query does. The
 * count is logged so a silent empty set is visible.
 */
async function ownEbayListingIds(): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin
    .from("listings")
    .select("platform_listing_id")
    .eq("platform", "ebay")
    .not("platform_listing_id", "is", null)
    .limit(SCAN_LIMIT * 4);
  if (error) {
    console.error("[style-code-sweep] own-listing read failed:", error.message);
    return new Set();
  }
  const ids = new Set(
    ((data ?? []) as Array<{ platform_listing_id: string | null }>)
      .map((r) => (r.platform_listing_id ?? "").trim())
      .filter(Boolean),
  );
  return ids;
}

function makeLiveDeps(ownEbayItemIds: ReadonlySet<string>): SweepDeps {
  return {
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
      .filter((i) => i.title !== "" && i.itemId)
      .map((i) => ({ itemId: i.itemId, title: i.title, url: i.itemWebUrl ?? null }));
  },
  observe: (candidate, hits) =>
    recordStyleCodeObservations({
      brandKey: candidate.brandKey,
      styleCodeRaw: candidate.styleCodeRaw,
      titles: hits,
      source: "market_verify",
    }),
  resolveName: async (candidate, hits) => {
    // US-2751: THE NAME COMES FROM ITEM SPECIFICS, NOT FROM TITLES.
    //
    // The previous version took the run of words most listing TITLES shared. A
    // title is marketing text assembled by a seller who may have bought the
    // garment with no tag beyond a size dot, so a consensus over those is a
    // confident guess. Worse, our own sellers publish with titles our AI wrote,
    // so reading them back counted our guesses as independent corroboration.
    //
    // Now a listing only counts if it DECLARES this code in a structured field
    // (Style Code / MPN) and names a product in one (Model). That is a name
    // attached to a verified identifier by someone who typed both.
    const classified: ClassifiedListing[] = [];
    for (const hit of hits.slice(0, ASPECT_LOOKUPS_PER_CODE)) {
      const listing = await getBrowseItemAspects(hit.itemId);
      if (!listing) continue;
      classified.push(
        classifyListing({
          listing,
          canonicalCode: candidate.styleCodeNorm,
          canonicalize: (raw) => canonicalStyleCode(candidate.brandKey, raw),
          ownItemIds: ownEbayItemIds,
        }),
      );
    }

    const evidence = aspectEvidence(classified);
    if (evidence.contradicting > 0 && evidence.confirming === 0) {
      // Every listing that declared a code declared a DIFFERENT one. That is a
      // signal about our canonicalization, not about the market, and it is
      // worth saying out loud rather than recording as a quiet miss.
      console.warn(
        `[style-code-sweep] ${candidate.styleCodeNorm}: ${evidence.contradicting} listing(s) ` +
          "declared a different style code and none matched",
      );
    }
    if (!evidence.name) return;

    const { error } = await supabaseAdmin.rpc("record_style_code_name", {
      p_brand_key: candidate.brandKey,
      p_style_code_norm: candidate.styleCodeNorm,
      p_style_code_raw: candidate.styleCodeRaw,
      p_name: evidence.name,
      p_source: "consensus",
      p_supporting: evidence.confirming,
      // US-2782: the band moved to aspectNameConfidence, shared with the
      // discovery crawl. Same evidence, so it must be the same number.
      p_confidence: aspectNameConfidence(evidence.confirming),
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
}

/** The lock is a seam so the concurrency guarantee is a test, not a claim. */
export type LockAcquirer = typeof acquireJobLock;

export async function handleStyleCodeSweepCron(
  c: Context,
  // US-2751: null means "build the live deps for this tick", which needs the
  // own-listing set and therefore a read. Tests pass their own.
  deps: SweepDeps | null = null,
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

    // Read once per tick, before any code is swept.
    const effectiveDeps = deps ?? makeLiveDeps(await ownEbayListingIds());

    const outcomes: SweepOutcome[] = [];
    for (const candidate of work.candidates) {
      outcomes.push(await sweepOneCode(candidate, effectiveDeps));
    }

    // Say what was left behind. A sweep that reports only what it did reads as
    // "we covered everything" on a run that covered a hundredth of the backlog.
    console.log(
      `[style-code-sweep] considered=${work.considered} swept=${work.candidates.length} ` +
        `deferred=${work.deferred} skipped_confirmed=${work.skippedConfirmed} ` +
        `skipped_cooldown=${work.skippedCooldown} skipped_short=${work.skippedTooShort}`,
    );

    // US-2714: reconcile BEFORE reporting, so a tick's output describes the
    // index as it now stands rather than as it was when the tick began.
    const rekey = await reconcileKeys();
    if (rekey.moved || rekey.dropped || rekey.conflicts || rekey.failed) {
      console.log(
        `[style-code-sweep] rekey moved=${rekey.moved} dropped=${rekey.dropped} ` +
          `conflicts=${rekey.conflicts} failed=${rekey.failed} correct=${rekey.correct}`,
      );
    }

    return c.json({
      ok: true,
      rekey,
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
