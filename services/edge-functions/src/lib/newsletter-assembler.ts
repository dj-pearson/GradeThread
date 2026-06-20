// US-923: newsletter issue assembler — DB-touching, shared by the admin console's
// "build next" button (admin-newsletter.ts) and the autonomous kickoff tick
// (routes/newsletter-scheduler.ts) so the two NEVER drift on how an issue is born.
//
// It scaffolds the next editable draft, biasing topic / subject-style / send-hour by
// the self-tuning weights (US-928) and stamping the chosen dimensions on the issue so
// the next analysis pass can attribute engagement. The autonomous copywriter (sibling
// story) overwrites the placeholder subject/sections with real content into the same
// shape — the assembler only guarantees a well-formed, schedulable draft exists.

import { supabaseAdmin } from "./supabase.ts";
import { getSetting } from "./system-settings.ts";
import { type NewsletterSection, runIssueQa } from "./newsletter-issue.ts";
import { type SubjectVariant } from "./newsletter-ab.ts";
import {
  NEWSLETTER_TOPICS,
  selectWeightedKey,
  SUBJECT_STYLES,
  subjectStyleById,
  topicById,
} from "./newsletter-tuning.ts";

// The full column projection the console returns for an issue. Kept here (with the
// assembler that inserts the row) so both callers select the identical shape.
export const NEWSLETTER_ISSUE_COLS =
  "id, title, subject, preheader, sections, status, audience, segment_id, " +
  "scheduled_for, qa_results, recipients_total, sent_count, skipped_count, " +
  "failed_count, block_reason, created_by, approved_by, approved_at, " +
  "send_started_at, sent_at, created_at, updated_at, " +
  "pillar, angle, subject_style, send_hour, " +
  "subject_variants, ab_metric, ab_test_fraction, ab_measurement_hours, " +
  "ab_phase, ab_test_started_at, ab_winner_variant, ab_winner_source";

// Uniform-weight fallback (cold start, before any engagement is recorded) so the
// assembler still rotates across the catalog instead of always picking the first.
function uniformWeights(ids: string[]): Record<string, number> {
  return Object.fromEntries(ids.map((id) => [id, 1]));
}

// The next future UTC datetime whose hour == `hour`. Pure given `nowMs`.
export function nextSendAt(hour: number, nowMs: number): string {
  const d = new Date(nowMs);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(hour);
  if (d.getTime() <= nowMs) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

// US-928: the self-tuning bias the assembler reads. Topic + subject-style selection
// are weighted by the computed stores (favoring higher-engaging, away from paused),
// and the send time consumes the per-hour stats. All data-driven — the cron populates
// the stores from engagement; this just consumes them.
export async function loadAssemblerBias(): Promise<{
  topicWeights: Record<string, number>;
  styleWeights: Record<string, number>;
  bestHour: number | null;
}> {
  const [topicWeights, styleWeights, hourStats] = await Promise.all([
    getSetting<Record<string, number>>("newsletter_topic_weights", {}),
    getSetting<Record<string, number>>("newsletter_subject_style_weights", {}),
    getSetting<{ bestHour: number | null }>("newsletter_send_hour_stats", { bestHour: null }),
  ]);
  return {
    topicWeights: topicWeights ?? {},
    styleWeights: styleWeights ?? {},
    bestHour: typeof hourStats?.bestHour === "number" ? hourStats.bestHour : null,
  };
}

export interface AssembledIssue {
  id: string;
  title: string;
  subject: string;
  status: string;
  scheduled_for: string | null;
  pillar: string | null;
  angle: string | null;
  subject_style: string | null;
  send_hour: number | null;
  /** The full row (NEWSLETTER_ISSUE_COLS projection) so the console can return it as-is. */
  row: unknown;
}

export interface AssembleResult {
  /** The inserted draft, or null when the insert failed. */
  issue: AssembledIssue | null;
  /** Audit/log detail: which catalog dimensions were chosen. */
  chosen: { topicId: string; styleId: string; sendHour: number };
  error?: string;
}

/**
 * Build (insert) the next editable draft issue. Returns the inserted row plus the
 * chosen dimensions for the caller's audit log. Pure-input via `nowMs` so the
 * scheduled-for instant is deterministic in tests.
 */
export async function assembleNextIssue(
  createdBy: string | null,
  nowMs: number,
): Promise<AssembleResult> {
  const bias = await loadAssemblerBias();
  const seed = `nl-${nowMs}`;

  // A weighted pick that can't resolve to a catalog entry (empty/stale weights)
  // falls back to a uniform pick over the live catalog — always resolvable.
  const topic =
    topicById(selectWeightedKey(bias.topicWeights, seed) ?? "") ??
    topicById(selectWeightedKey(uniformWeights(NEWSLETTER_TOPICS.map((t) => t.id)), seed)!)!;

  const style =
    subjectStyleById(selectWeightedKey(bias.styleWeights, `${seed}:style`) ?? "") ??
    subjectStyleById(
      selectWeightedKey(uniformWeights(SUBJECT_STYLES.map((s) => s.id)), `${seed}:style`)!,
    )!;

  // Send-time optimization: use the learned best hour, else a sensible default.
  const sendHour = bias.bestHour ?? 14;
  const scheduledFor = nextSendAt(sendHour, nowMs);

  const sections: NewsletterSection[] = [
    {
      heading: topic.label,
      body:
        `<p>Draft issue on <strong>${topic.label}</strong> (pillar: ${topic.pillar}). ` +
        `Suggested subject style: <em>${style.label}</em> — ${style.guidance} ` +
        `Edit these sections before sending.</p>`,
    },
  ];
  const qa = runIssueQa({ subject: "", sections });

  // US-927: seed two starter subject variants so the issue can run an A/B test out
  // of the box. The copywriter (sibling story) overwrites these with real variants.
  const subjectVariants: SubjectVariant[] = [
    { id: "a", subject: topic.label, label: "Variant A" },
    { id: "b", subject: `${topic.label}: what most resellers miss`, label: "Variant B" },
  ];

  const { data, error } = await supabaseAdmin
    .from("newsletter_issues")
    .insert({
      title: topic.label,
      subject: "",
      sections,
      subject_variants: subjectVariants,
      status: "draft",
      qa_results: qa,
      pillar: topic.pillar,
      angle: topic.angle,
      subject_style: style.id,
      send_hour: sendHour,
      scheduled_for: scheduledFor,
      created_by: createdBy,
    })
    .select(NEWSLETTER_ISSUE_COLS)
    .maybeSingle();

  const chosen = { topicId: topic.id, styleId: style.id, sendHour };
  if (error || !data) {
    return { issue: null, chosen, error: error?.message ?? "insert returned no row" };
  }

  const row = data as unknown as {
    id: string;
    title: string;
    subject: string;
    status: string;
    scheduled_for: string | null;
    pillar: string | null;
    angle: string | null;
    subject_style: string | null;
    send_hour: number | null;
  };

  return {
    issue: {
      id: row.id,
      title: row.title,
      subject: row.subject,
      status: row.status,
      scheduled_for: row.scheduled_for,
      pillar: row.pillar,
      angle: row.angle,
      subject_style: row.subject_style,
      send_hour: row.send_hour,
      row: data,
    },
    chosen,
  };
}
