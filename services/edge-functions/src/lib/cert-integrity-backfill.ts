// Certificate-integrity backfill + share monitoring (US-490).
//
// Grades finalized before US-333 have no content_hash, so their public
// certificates verify as "unverifiable" — truthful, but a weak trust story at
// launch. This job seals those legacy rows under the CURRENT integrity scheme
// (buildCertIntegrity: hash + HMAC signature when CERT_SIGNING_KEY is set), so
// every certified report verifies. Idempotent: it only touches rows whose
// content_hash is still NULL, and the UPDATE re-asserts that, so it can never
// clobber a hash written by the grading pipeline or a concurrent sweep.
//
// The same module computes the signed / hash-only / unverifiable share of all
// certified reports and emits it as metrics — recorded by this job AND by the
// recurring integrity-scan cron, so the share keeps being tracked after the
// backfill drains to zero (a regression to hash-only would mean the signing
// key fell out of the environment).

import { supabaseAdmin } from "./supabase.ts";
import { requireJobSecret } from "./job-auth.ts";
import { acquireJobLock } from "./job-lock.ts";
import { captureException, logEvent, recordMetric } from "./observability.ts";
import { buildCertIntegrity, type CertIntegrity } from "./cert-integrity.ts";

const BATCH_LIMIT = 100;
// Per-tick ceiling. The job is idempotent, so a table larger than this simply
// drains over successive ticks instead of holding the lock for minutes.
const MAX_BATCHES = 50;

export interface UnsealedCertRow {
  id: string;
  certificate_id: string;
  overall_score: number | string;
  grade_tier: string;
  fabric_condition_score: number | string;
  structural_integrity_score: number | string;
  cosmetic_appearance_score: number | string;
  functional_elements_score: number | string;
  odor_cleanliness_score: number | string;
  ai_summary: string | null;
  buyer_writeup: string | null;
}

export interface CertIntegrityShare {
  signed: number;
  hash_only: number;
  unverifiable: number;
  total: number;
}

export interface CertBackfillResult {
  scanned: number;
  sealed: number;
  failed: number;
}

// Injectable data access so the sweep's orchestration is unit-testable without
// a DB (mirrors the injectable-store idiom in stuck-submissions.ts).
export interface CertBackfillStore {
  /**
   * Certified reports (certificate_id set) with no content_hash yet.
   * `excludeIds` are rows that already failed to seal this tick — excluding
   * them lets the scan progress past a page of poisoned rows.
   */
  findUnsealed: (limit: number, excludeIds: string[]) => Promise<UnsealedCertRow[]>;
  /**
   * Persist the integrity payload, re-asserting content_hash IS NULL in the
   * UPDATE. Returns true only when the row actually transitioned — a row
   * sealed in the race window fails the match and is left alone.
   */
  seal: (reportId: string, integrity: CertIntegrity) => Promise<boolean>;
  /** Signed / hash-only / unverifiable counts across all certified reports. */
  countShare: () => Promise<CertIntegrityShare>;
}

const defaultStore: CertBackfillStore = {
  findUnsealed: async (limit, excludeIds) => {
    let query = supabaseAdmin
      .from("grade_reports")
      .select(
        "id, certificate_id, overall_score, grade_tier, fabric_condition_score, " +
          "structural_integrity_score, cosmetic_appearance_score, " +
          "functional_elements_score, odor_cleanliness_score, ai_summary, buyer_writeup",
      )
      .not("certificate_id", "is", null)
      .is("content_hash", null)
      .order("created_at", { ascending: true })
      .limit(limit);
    if (excludeIds.length > 0) {
      // UUIDs only — safe to interpolate into the PostgREST in-list.
      query = query.not("id", "in", `(${excludeIds.join(",")})`);
    }
    const { data, error } = await query;
    if (error) {
      captureException(error, { route: "cert-integrity-backfill.scan" });
      throw new Error(`cert-integrity backfill scan failed: ${error.message}`);
    }
    return (data ?? []) as unknown as UnsealedCertRow[];
  },
  seal: async (reportId, integrity) => {
    const { data, error } = await supabaseAdmin
      .from("grade_reports")
      .update({
        content_hash: integrity.content_hash,
        content_signature: integrity.content_signature,
        integrity_version: integrity.integrity_version,
      })
      .eq("id", reportId)
      .is("content_hash", null)
      .select("id")
      .maybeSingle();
    if (error) {
      captureException(error, {
        route: "cert-integrity-backfill.seal",
        extra: { reportId },
      });
      throw new Error(`cert-integrity seal failed: ${error.message}`);
    }
    return Boolean(data);
  },
  countShare: async () => {
    // Head-only count queries; each starts from "all certified reports".
    const certified = () =>
      supabaseAdmin
        .from("grade_reports")
        .select("id", { count: "exact", head: true })
        .not("certificate_id", "is", null);
    const resolve = async (
      q: PromiseLike<{ count: number | null; error: { message: string } | null }>,
    ): Promise<number> => {
      const { count, error } = await q;
      if (error) {
        captureException(error, { route: "cert-integrity-backfill.share" });
        throw new Error(`cert-integrity share count failed: ${error.message}`);
      }
      return count ?? 0;
    };
    const [total, signed, hash_only, unverifiable] = await Promise.all([
      resolve(certified()),
      resolve(certified().not("content_signature", "is", null)),
      resolve(certified().not("content_hash", "is", null).is("content_signature", null)),
      resolve(certified().is("content_hash", null)),
    ]);
    return { signed, hash_only, unverifiable, total };
  },
};

// Seal every certified report that has no integrity hash. Rows whose fields
// can't be hashed (e.g. a non-numeric score) are counted as failed, reported,
// and excluded from later pages this tick, so a poisoned page can't loop the
// sweep or block the rows behind it. The `seen` set is a second guard against
// a store that doesn't honor the exclusion.
export async function backfillCertificateIntegrity(
  store: CertBackfillStore = defaultStore,
): Promise<CertBackfillResult> {
  const seen = new Set<string>();
  const failedIds: string[] = [];
  let sealed = 0;
  let failed = 0;

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const rows = await store.findUnsealed(BATCH_LIMIT, failedIds);
    const fresh = rows.filter((r) => !seen.has(r.id));
    if (fresh.length === 0) break; // drained, or only poisoned rows remain

    for (const row of fresh) {
      seen.add(row.id);
      try {
        // Seal under the CURRENT scheme: legacy rows have no buyer_writeup, so
        // v2 canonicalizes it as "" — exactly what the verify endpoint passes
        // back (`r.buyer_writeup ?? ""`), so the backfilled hash round-trips.
        const integrity = await buildCertIntegrity({
          certificate_id: row.certificate_id,
          overall_score: row.overall_score,
          grade_tier: row.grade_tier,
          fabric_condition_score: row.fabric_condition_score,
          structural_integrity_score: row.structural_integrity_score,
          cosmetic_appearance_score: row.cosmetic_appearance_score,
          functional_elements_score: row.functional_elements_score,
          odor_cleanliness_score: row.odor_cleanliness_score,
          ai_summary: row.ai_summary ?? "",
          buyer_writeup: row.buyer_writeup,
        });
        if (await store.seal(row.id, integrity)) {
          sealed += 1;
        }
      } catch (err) {
        failed += 1;
        failedIds.push(row.id);
        captureException(err, {
          route: "cert-integrity-backfill.row",
          extra: { reportId: row.id },
        });
      }
    }

    if (rows.length < BATCH_LIMIT) break; // last page
  }

  if (sealed > 0) {
    recordMetric("certificates.integrity_backfilled", sealed, {});
    logEvent("info", "cert_integrity.backfilled", { sealed, failed });
  }
  if (failed > 0) {
    // Unsealable rows mean corrupt grade data — surface loudly, don't loop.
    captureException(
      new Error(`${failed} certified report(s) could not be integrity-sealed`),
      { level: "warn", route: "cert-integrity-backfill", tags: { count: String(failed) } },
    );
  }
  return { scanned: seen.size, sealed, failed };
}

// Emit the signed / hash-only / unverifiable split of certified reports as
// metrics (US-490 AC#3). After the backfill drains, unverifiable should sit at
// 0 and hash_only should not grow — growth there means CERT_SIGNING_KEY fell
// out of the environment (the prod boot assert in env-validation.ts catches a
// fully missing key; this catches drift on rows minted while it was absent).
export async function recordCertificateIntegrityShare(
  store: CertBackfillStore = defaultStore,
): Promise<CertIntegrityShare> {
  const share = await store.countShare();
  recordMetric("certificates.integrity_share", share.signed, { status: "signed" });
  recordMetric("certificates.integrity_share", share.hash_only, { status: "hash_only" });
  recordMetric("certificates.integrity_share", share.unverifiable, { status: "unverifiable" });
  recordMetric("certificates.integrity_share", share.total, { status: "total" });
  return share;
}

// Cron/one-off entry point. Mounted OUTSIDE the /api/* JWT groups; guards with
// the shared internal-job secret and an overlap lock (mirrors the other crons).
export async function handleCertIntegrityBackfillCron(c: {
  req: { header: (name: string) => string | undefined };
  json: (body: unknown, status?: number) => Response;
}): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const lock = await acquireJobLock("cert-integrity-backfill", 300);
  if (!lock.acquired) {
    return c.json({ ok: true, skipped: true, reason: lock.reason });
  }
  try {
    const result = await backfillCertificateIntegrity();
    const share = await recordCertificateIntegrityShare();
    return c.json({ ok: true, ...result, share });
  } catch (err) {
    captureException(err, { route: "cert-integrity-backfill.cron" });
    return c.json({ error: "Certificate integrity backfill failed" }, 500);
  } finally {
    await lock.release();
  }
}
