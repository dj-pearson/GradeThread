// US-1103: Garment Passport integrity-scan cron.
//
// Populates the durable passport_integrity_signals queue the admin Integrity
// console triages. Four detectors run here, each reusing existing passport data:
//   • wear_reversal         — condition that IMPROVED across consecutive
//                             fingerprints of the same garment (impossible chain).
//   • duplicate_fingerprint — the same visual fingerprint on two ACTIVE garments
//                             held by DIFFERENT owner nodes.
//   • rapid_reclaim         — a passport claimed many times in a short window.
//   • token_replay          — repeated rejected redemptions of a known token.
//
// Idempotent: every signal carries a stable dedupe_key, so a re-run UPDATES an
// existing open/reviewing signal's evidence + last_seen rather than duplicating,
// and never reopens one an operator already actioned/dismissed (status is not in
// the upsert payload).
//
// Mounted in main.ts as POST /api/jobs/passport-integrity-scan, OUTSIDE the
// /api/* JWT groups, gated by the internal job secret (same pattern as the other
// crons). Also invokable on-demand by an admin via the integrity route's /scan.

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import {
  type ActiveGarmentFingerprint,
  buildDuplicateFingerprintSignals,
  buildRapidReclaimSignals,
  buildTokenReplaySignals,
  buildWearReversalSignals,
  type ClaimAttemptRow,
  type FingerprintRow,
  type IntegritySignalRecord,
  type ReplayAttemptRow,
} from "../lib/passport-integrity.ts";
import { emitOpsEvent } from "../lib/ops-events.ts";

// Bounded corpora for the O(n^2) / windowed scans.
const FINGERPRINT_SCAN_CAP = 5000; // recent fingerprints for wear + duplicate
const DUP_CANDIDATE_CAP = 2500; // active-garment fingerprints for the n^2 pass
const CLAIM_WINDOW_CAP = 5000; // recent claim attempts
const RECLAIM_WINDOW_HOURS = 72;
const REPLAY_WINDOW_HOURS = 72;
// A passport claimed at least this many times in the window is suspicious.
const RAPID_RECLAIM_THRESHOLD = 3;
// A token receiving at least this many rejected redemptions is a replay probe.
const TOKEN_REPLAY_THRESHOLD = 3;

interface FingerprintDbRow {
  id: string;
  garment_id: string;
  grade_report_id: string | null;
  wear_score: number | string | null;
  payload: { phashes?: Record<string, unknown> } | null;
  created_at: string | null;
}

/**
 * Upsert one batch of integrity signals. Idempotent via the dedupe_key unique
 * index: re-running refreshes evidence + last_seen for a still-open/reviewing
 * signal; status is NOT in the payload, so an actioned/dismissed signal stays
 * resolved (its evidence may still refresh — desirable for forensics). Returns
 * the number of rows written best-effort.
 */
async function upsertSignals(records: IntegritySignalRecord[]): Promise<number> {
  if (records.length === 0) return 0;
  const nowIso = new Date().toISOString();
  const rows = records.map((r) => ({
    signal_type: r.signal_type,
    severity: r.severity,
    garment_id: r.garment_id,
    dedupe_key: r.dedupe_key,
    evidence: r.evidence,
    last_seen_at: nowIso,
    updated_at: nowIso,
  }));
  const { error } = await supabaseAdmin
    .from("passport_integrity_signals")
    .upsert(rows, { onConflict: "dedupe_key" });
  if (error) {
    console.error("[passport-integrity] upsert failed:", error.message);
    return 0;
  }
  return rows.length;
}

function phashMapOf(payload: FingerprintDbRow["payload"]): Record<string, string> {
  const ph = payload?.phashes;
  if (!ph || typeof ph !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ph)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Run all four integrity detectors and upsert the results. Shared by the cron and
 * the admin on-demand /scan trigger. Returns per-detector counts.
 */
export async function runPassportIntegrityScan(): Promise<{
  wear_reversal: number;
  duplicate_fingerprint: number;
  rapid_reclaim: number;
  token_replay: number;
  written: number;
  truncated: string[];
}> {
  const truncated: string[] = [];

  // ── Load recent fingerprints (drives wear + duplicate) ───────────────────────
  const { data: fpRaw, error: fpErr } = await supabaseAdmin
    .from("garment_fingerprints")
    .select("id, garment_id, grade_report_id, wear_score, payload, created_at")
    .order("created_at", { ascending: false })
    .limit(FINGERPRINT_SCAN_CAP);
  if (fpErr) console.error("[passport-integrity] fingerprint load failed:", fpErr.message);
  const fpRows = (fpRaw ?? []) as FingerprintDbRow[];
  if (fpRows.length >= FINGERPRINT_SCAN_CAP) truncated.push("fingerprints");

  // 1. wear reversal — per garment, across consecutive fingerprints.
  const wearRows: FingerprintRow[] = fpRows.map((r) => ({
    id: r.id,
    garment_id: r.garment_id,
    grade_report_id: r.grade_report_id,
    wear_score: typeof r.wear_score === "string" ? Number(r.wear_score) : (r.wear_score ?? 0),
    created_at: r.created_at,
  }));
  const wearSignals = buildWearReversalSignals(wearRows);

  // 2. duplicate fingerprint — across ACTIVE garments with DIFFERENT owners. Pull
  //    the active garments referenced by the loaded fingerprints + their current
  //    owner node, then compare the LATEST fingerprint phashes per garment.
  const garmentIds = [...new Set(fpRows.map((r) => r.garment_id))].slice(0, DUP_CANDIDATE_CAP);
  if ([...new Set(fpRows.map((r) => r.garment_id))].length > DUP_CANDIDATE_CAP) {
    truncated.push("dup_candidates");
  }
  const ownerByGarment = new Map<string, string | null>();
  const statusByGarment = new Map<string, string>();
  if (garmentIds.length > 0) {
    const { data: garments } = await supabaseAdmin
      .from("garments")
      .select("id, current_owner_node_id, status")
      .in("id", garmentIds);
    for (
      const g of (garments ?? []) as Array<
        { id: string; current_owner_node_id: string | null; status: string }
      >
    ) {
      ownerByGarment.set(g.id, g.current_owner_node_id);
      statusByGarment.set(g.id, g.status);
    }
  }
  // Latest fingerprint per garment (fpRows already newest-first).
  const latestFpByGarment = new Map<string, FingerprintDbRow>();
  for (const r of fpRows) {
    if (!latestFpByGarment.has(r.garment_id)) latestFpByGarment.set(r.garment_id, r);
  }
  const activeGarments: ActiveGarmentFingerprint[] = [];
  for (const [garmentId, fp] of latestFpByGarment) {
    if (statusByGarment.get(garmentId) !== "active") continue; // only active chains
    activeGarments.push({
      garment_id: garmentId,
      owner_node_id: ownerByGarment.get(garmentId) ?? null,
      phashes: phashMapOf(fp.payload),
    });
  }
  const dupSignals = buildDuplicateFingerprintSignals(activeGarments);

  // ── Load recent claim attempts (drives rapid_reclaim + token_replay) ─────────
  const sinceIso = new Date(Date.now() - RECLAIM_WINDOW_HOURS * 3600 * 1000).toISOString();
  const { data: attemptsRaw, error: atErr } = await supabaseAdmin
    .from("passport_claim_attempts")
    .select("garment_id, token_hash, outcome, created_at")
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(CLAIM_WINDOW_CAP);
  if (atErr) console.error("[passport-integrity] claim-attempt load failed:", atErr.message);
  const attempts = (attemptsRaw ?? []) as Array<{
    garment_id: string | null;
    token_hash: string;
    outcome: "claimed" | "rejected";
    created_at: string | null;
  }>;
  if (attempts.length >= CLAIM_WINDOW_CAP) truncated.push("claim_attempts");

  // 3. rapid re-claim — successful claims per garment in the window.
  const reclaimRows: ClaimAttemptRow[] = attempts;
  const reclaimSignals = buildRapidReclaimSignals(reclaimRows, {
    threshold: RAPID_RECLAIM_THRESHOLD,
    sinceIso,
    windowHours: RECLAIM_WINDOW_HOURS,
  });

  // 4. token replay — rejected attempts against a token that resolves to a known
  //    garment. Only attempts WITH a garment_id (a resolved, real token) count.
  const replayRows: ReplayAttemptRow[] = attempts
    .filter((a): a is ReplayAttemptRow => !!a.garment_id);
  const replaySignals = buildTokenReplaySignals(replayRows, {
    threshold: TOKEN_REPLAY_THRESHOLD,
    sinceIso,
    windowHours: REPLAY_WINDOW_HOURS,
  });

  const wearWritten = await upsertSignals(wearSignals);
  const dupWritten = await upsertSignals(dupSignals);
  const reclaimWritten = await upsertSignals(reclaimSignals);
  const replayWritten = await upsertSignals(replaySignals);
  const written = wearWritten + dupWritten + reclaimWritten + replayWritten;

  if (written > 0) {
    const all = [...wearSignals, ...dupSignals, ...reclaimSignals, ...replaySignals];
    const sev = all.some((s) => s.severity === "critical")
      ? "critical"
      : all.some((s) => s.severity === "high")
      ? "warning"
      : "info";
    void emitOpsEvent("passport.integrity", sev, {
      title: `Passport integrity scan raised ${written} signal${written === 1 ? "" : "s"} ` +
        `(${wearSignals.length} wear, ${dupSignals.length} duplicate, ` +
        `${reclaimSignals.length} reclaim, ${replaySignals.length} replay)`,
      source: "passport-integrity-scan",
      data: {
        wear_reversal: wearSignals.length,
        duplicate_fingerprint: dupSignals.length,
        rapid_reclaim: reclaimSignals.length,
        token_replay: replaySignals.length,
        written,
      },
    });
  }

  if (truncated.length > 0) {
    console.warn(`[passport-integrity] candidate caps hit: ${truncated.join(", ")}`);
  }

  return {
    wear_reversal: wearSignals.length,
    duplicate_fingerprint: dupSignals.length,
    rapid_reclaim: reclaimSignals.length,
    token_replay: replaySignals.length,
    written,
    truncated,
  };
}

export async function handlePassportIntegrityScanCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const lock = await acquireJobLock("passport-integrity-scan", 300);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const result = await runPassportIntegrityScan();
    return c.json({ ok: true, ...result });
  } finally {
    await lock.release();
  }
}
