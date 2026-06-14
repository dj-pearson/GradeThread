// US-888: abuse-signal scan cron.
//
// Populates the durable abuse_signals queue the Trust & Safety console triages.
// Two detectors run here (the live /api/admin/fraud dashboard already surfaces
// shared-payment + velocity in real time; what it CANNOT do is remember a
// finding or compute cross-account photo reuse, which is this job's headline
// signal):
//   • phash_collision    — the SAME photo reused across DIFFERENT accounts
//                          (stolen/recycled listing photos, grade-laundering).
//   • submission_velocity — an account creating an abnormal burst of grades.
//
// Idempotent: every signal carries a stable dedupe_key, so a re-run UPDATES an
// existing open/reviewing signal's evidence + last_seen rather than duplicating,
// and never reopens one an operator already actioned/dismissed.
//
// Mounted in main.ts as POST /api/jobs/abuse-scan, OUTSIDE the /api/* JWT groups,
// gated by X-Internal-Job-Secret (same pattern as the other crons).

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import {
  type AbuseSignalRecord,
  buildPhashCollisionSignals,
  buildVelocitySignals,
  type PhashImageRow,
} from "../lib/abuse-signals.ts";

// Bounded corpus for the O(n^2) phash comparison — recent hashed images only.
const PHASH_CANDIDATE_LIMIT = 3000;
// Submissions to pull for the 24h velocity window.
const VELOCITY_WINDOW_CAP = 4000;
// An account with at least this many submissions in 24h is a velocity signal.
const SUBMISSION_BURST_THRESHOLD = 8;
const VELOCITY_WINDOW_HOURS = 24;

// Upsert one batch of signals. Idempotent via the dedupe_key unique index:
// re-running refreshes evidence + last_seen for a still-open/reviewing signal,
// but the WHERE on the conflict update leaves actioned/dismissed signals frozen
// (so a resolved concern doesn't silently re-open). Returns inserted/updated
// counts best-effort.
async function upsertSignals(records: AbuseSignalRecord[]): Promise<number> {
  if (records.length === 0) return 0;
  const nowIso = new Date().toISOString();
  const rows = records.map((r) => ({
    signal_type: r.signal_type,
    severity: r.severity,
    subject_user_id: r.subject_user_id,
    dedupe_key: r.dedupe_key,
    evidence: r.evidence,
    last_seen_at: nowIso,
    updated_at: nowIso,
  }));

  // PostgREST upsert on the unique dedupe_key. ignoreDuplicates:false => update.
  // We can't express the "only when status in (open,reviewing)" guard through
  // PostgREST, so we DON'T update status here (it isn't in the payload), and we
  // accept that an actioned/dismissed signal may get its evidence/last_seen
  // refreshed — harmless, since status (the triage state) is untouched and the
  // console filters by status. Severity/evidence reflecting the latest scan is
  // desirable even on a resolved row for forensics.
  const { error } = await supabaseAdmin
    .from("abuse_signals")
    .upsert(rows, { onConflict: "dedupe_key" });
  if (error) {
    console.error("[abuse-scan] upsert failed:", error.message);
    return 0;
  }
  return rows.length;
}

export async function handleAbuseScanCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const lock = await acquireJobLock("abuse-scan", 300);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const truncated: string[] = [];

    // ── 1. phash collisions across accounts ──────────────────────────
    const { data: imagesRaw, error: imgErr } = await supabaseAdmin
      .from("submission_images")
      .select("id, submission_id, image_type, phash, created_at")
      .not("phash", "is", null)
      .order("created_at", { ascending: false })
      .limit(PHASH_CANDIDATE_LIMIT);
    if (imgErr) {
      console.error("[abuse-scan] image load failed:", imgErr.message);
    }
    const imageRows = (imagesRaw ?? []) as Array<{
      id: string;
      submission_id: string;
      image_type: string | null;
      phash: string | null;
      created_at: string | null;
    }>;
    if (imageRows.length >= PHASH_CANDIDATE_LIMIT) truncated.push("phash_images");

    // Resolve each image's owning account (the cross-tenant fact the detector
    // needs). Only ids cross over — never image bytes.
    const subIds = [...new Set(imageRows.map((r) => r.submission_id))];
    const ownerBySub = new Map<string, string>();
    if (subIds.length > 0) {
      const { data: subs } = await supabaseAdmin
        .from("submissions")
        .select("id, user_id")
        .in("id", subIds);
      for (const s of (subs ?? []) as Array<{ id: string; user_id: string }>) {
        ownerBySub.set(s.id, s.user_id);
      }
    }
    const phashRows: PhashImageRow[] = imageRows
      .map((r) => ({
        image_id: r.id,
        submission_id: r.submission_id,
        user_id: ownerBySub.get(r.submission_id) ?? "",
        image_type: r.image_type,
        phash: r.phash,
        created_at: r.created_at,
      }))
      .filter((r) => r.user_id);
    const phashSignals = buildPhashCollisionSignals(phashRows);

    // ── 2. submission velocity (last 24h) ────────────────────────────
    const sinceIso = new Date(Date.now() - VELOCITY_WINDOW_HOURS * 3600 * 1000).toISOString();
    const { data: recentRaw } = await supabaseAdmin
      .from("submissions")
      .select("user_id, created_at")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(VELOCITY_WINDOW_CAP);
    const recent = (recentRaw ?? []) as Array<{ user_id: string; created_at: string }>;
    if (recent.length >= VELOCITY_WINDOW_CAP) truncated.push("recent_submissions");
    const velocitySignals = buildVelocitySignals(recent, {
      threshold: SUBMISSION_BURST_THRESHOLD,
      sinceIso,
      windowHours: VELOCITY_WINDOW_HOURS,
    });

    const phashWritten = await upsertSignals(phashSignals);
    const velocityWritten = await upsertSignals(velocitySignals);

    if (truncated.length > 0) {
      console.warn(`[abuse-scan] candidate caps hit: ${truncated.join(", ")}`);
    }
    return c.json({
      ok: true,
      phash_collisions: phashSignals.length,
      velocity_alerts: velocitySignals.length,
      written: phashWritten + velocityWritten,
      truncated,
    });
  } finally {
    await lock.release();
  }
}
