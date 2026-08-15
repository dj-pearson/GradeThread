// US-2035 / US-481: measure whether a regrade of the SAME photos lands on the
// same score.
//
// WHY THIS EXISTS AT ALL. `ai-config.ts` documented that grading is pinned to a
// low temperature so decoding is near-greedy, and that is false on the shipping
// model: claude-sonnet-5 is effort-based, takes no temperature, and decodes
// non-greedily. So the determinism the "standardized grade" claim rests on is
// not enforced by the decoder — and `grading-reliability.ts`, which is the only
// thing that could DETECT the resulting variance, had zero non-test callers.
// The math was written, tested, and never run against a single real grade.
//
// The owner's call (2026-08-15) was to MEASURE before promising either way: it
// is a different product decision if the spread is 0.1 than if it is 0.8, and
// nobody had the number. This job produces it.
//
// ⚠️ COSTS REAL VISION CALLS, which is why it is OFF unless
// `GRADING_SELF_CONSISTENCY_SAMPLE` is set to a positive number. Each sampled
// submission is graded `runs` times from its stored images, so the bill is
// sample x runs x images. Defaults are deliberately small.
//
// It re-grades through `quickGrade`, and the reason that is the right instrument
// rather than a shortcut: it runs the same analyzeImage + compositeGrade the
// real pipeline runs, and the number being compared — `overallScore` — is
// untouched by the confidence caps layered on top. Those caps move confidence,
// never the score. Running the full pipeline instead would write submissions,
// charge credits and issue certificates, which is not a measurement.
//
// Mounted as POST /api/jobs/grading-self-consistency, gated by the internal job
// secret like every other cron.

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { quickGrade } from "../lib/quick-grade.ts";
import {
  assessSelfConsistency,
  gradeSelfConsistency,
  type SelfConsistencyItem,
} from "../lib/grading-reliability.ts";
import { captureException, recordMetric } from "../lib/observability.ts";
import { emitOpsEvent } from "../lib/ops-events.ts";

/** Signed-URL TTL for the sampled images. Long enough for N sequential grades. */
const IMAGE_URL_TTL_SECONDS = 900;

/** Images per sampled submission. Bounds the bill; the grader caps at 4 anyway. */
const MAX_IMAGES_PER_SAMPLE = 4;

/** How many times each sampled submission is graded. Two is enough to see a spread. */
const DEFAULT_RUNS = 2;

/** Hard ceiling on the sample, whatever the env says. */
const MAX_SAMPLE = 25;

function envInt(name: string, fallback: number): number {
  const raw = Number(Deno.env.get(name));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

interface SampledSubmission {
  id: string;
  garment_type: string | null;
  garment_category: string | null;
  brand: string | null;
  title: string | null;
}

/**
 * Recent submissions that produced a finalized grade, newest first.
 *
 * Deliberately NOT random: the question is whether the grader is reproducible
 * on the traffic it is seeing NOW, and a random draw across all history would
 * mix in submissions graded by prompt versions and models that are no longer
 * live. A moving window of recent work is the population the claim is about.
 */
async function sampleSubmissions(limit: number): Promise<SampledSubmission[]> {
  const { data, error } = await supabaseAdmin
    .from("grade_reports")
    .select("submission_id, created_at, submissions!inner(id, garment_type, garment_category, brand, title)")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`sample query failed: ${error.message}`);
  const rows = (data ?? []) as unknown as Array<{
    submissions: SampledSubmission;
  }>;
  return rows.map((r) => r.submissions).filter(Boolean);
}

/** Signed URLs for a submission's images, oldest display_order first. */
async function imageUrls(submissionId: string): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from("submission_images")
    .select("storage_path, image_type, display_order")
    .eq("submission_id", submissionId)
    .order("display_order", { ascending: true })
    .limit(MAX_IMAGES_PER_SAMPLE);
  const rows = (data ?? []) as Array<{ storage_path: string; image_type: string | null }>;
  const urls: string[] = [];
  for (const row of rows) {
    // submission-images is PRIVATE (US-276): signed reads only, never a public
    // URL. The TTL is short and the URL never leaves this process.
    const { data: signed } = await supabaseAdmin.storage
      .from("submission-images")
      .createSignedUrl(row.storage_path, IMAGE_URL_TTL_SECONDS);
    if (signed?.signedUrl) urls.push(signed.signedUrl);
  }
  return urls;
}

export async function handleGradingSelfConsistencyCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const sample = Math.min(envInt("GRADING_SELF_CONSISTENCY_SAMPLE", 0), MAX_SAMPLE);
  if (sample <= 0) {
    // Not an error: the default is off because the measurement costs money.
    return c.json({
      ok: true,
      skipped: "disabled",
      detail:
        "Set GRADING_SELF_CONSISTENCY_SAMPLE to a positive number to sample. " +
        "Each sampled submission is graded GRADING_SELF_CONSISTENCY_RUNS times " +
        "and costs that many vision calls per image.",
    });
  }
  const runs = Math.max(2, envInt("GRADING_SELF_CONSISTENCY_RUNS", DEFAULT_RUNS));

  // One at a time across replicas: two of these running together would double a
  // bill whose whole point is that it is bounded and deliberate.
  const lock = await acquireJobLock("grading-self-consistency", 30 * 60);
  if (!lock.acquired) return c.json({ ok: true, skipped: "locked" });

  const items: SelfConsistencyItem[] = [];
  const failures: string[] = [];
  try {
    const submissions = await sampleSubmissions(sample);
    for (const s of submissions) {
      try {
        const urls = await imageUrls(s.id);
        if (urls.length === 0) continue;
        const scores: number[] = [];
        for (let i = 0; i < runs; i++) {
          const g = await quickGrade({
            images: urls.map((url) => ({ url, type: "detail" })),
            garment: {
              garment_type: s.garment_type ?? undefined,
              garment_category: s.garment_category ?? undefined,
              brand: s.brand,
              title: s.title ?? undefined,
            },
          });
          scores.push(g.overallScore);
        }
        const result = gradeSelfConsistency(scores);
        items.push({ item_id: s.id, scores });
        recordMetric("grading.self_consistency.spread", result.max_spread);
      } catch (err) {
        // One submission failing is not the measurement failing. Record it so a
        // report built from three of twenty samples cannot read as twenty.
        failures.push(s.id);
        captureException(err, {
          level: "warn",
          route: "jobs.grading-self-consistency.sample",
        });
      }
    }

    const report = assessSelfConsistency(items);

    // The alert is the point of running it on a schedule rather than by hand.
    if (items.length > 0 && !report.passes) {
      await emitOpsEvent("grading_self_consistency_divergence", "warning", {
        title:
          `Regrades disagree: ${report.measured_item_count - Math.round(report.consistent_fraction * report.measured_item_count)}` +
          `/${report.measured_item_count} sampled submissions moved more than the tolerance ` +
          `(worst spread ${report.worst_spread}).`,
        source: "grading-self-consistency",
        data: { report, failures },
      });
    }

    return c.json({
      ok: true,
      sampled: items.length,
      requested: sample,
      runs,
      failures: failures.length,
      report,
    });
  } catch (err) {
    captureException(err, { route: "jobs.grading-self-consistency" });
    return c.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      500,
    );
  } finally {
    await lock.release();
  }
}
