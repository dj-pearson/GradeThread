// US-928: the newsletter self-tuning analysis pass (DB-touching).
//
// Aggregates recorded engagement (open / click / unsubscribe on the
// newsletter_issue_recipients ledger, attributed to each issue's topic / subject
// style / send hour) and turns it into selection weights via the PURE helpers in
// newsletter-tuning.ts. Persists the computed weights + a recommendations snapshot
// to the settings registry so the assembler reads them on the next build and the
// admin console can surface them (AC4). No manual inputs — every number comes from
// the engagement tables (AC5).
//
// Called from the scheduled cron (routes/jobs-newsletter-tuning.ts). Kept out of
// the pure module so that file stays supabase/env-free and unit-testable.

import { supabaseAdmin } from "./supabase.ts";
import { bustSettingCache, getSetting } from "./system-settings.ts";
import {
  aggregateEngagement,
  computeWeights,
  type DimensionScore,
  NEWSLETTER_TOPICS,
  recommendSendHour,
  type SendHourResult,
  SUBJECT_STYLES,
  topicByPillarAngle,
  type TuningConfig,
} from "./newsletter-tuning.ts";

// Look back this far when aggregating engagement — long enough to accumulate a
// trustworthy sample at a weekly cadence, recent enough to stay responsive.
const WINDOW_DAYS = 180;
// Bound the ledger scan so the pass stays cheap on a large list.
const RECIPIENT_SCAN_LIMIT = 50_000;

interface RecipientRow {
  issue_id: string;
  opened_at: string | null;
  clicked_at: string | null;
  unsubscribed_at: string | null;
}

interface IssueDims {
  pillar: string | null;
  angle: string | null;
  subject_style: string | null;
  send_hour: number | null;
}

export interface TuningRecommendations {
  computedAt: string;
  window: { days: number; since: string };
  config: TuningConfig;
  topicSent: number;
  topics: DimensionScore[];
  topicWinner: string | null;
  pausedTopics: string[];
  subjectStyles: DimensionScore[];
  subjectWinner: string | null;
  sendHour: SendHourResult;
  /** Per-issue rollup (most recent first) for transparency. */
  perIssue: Array<{
    issueId: string;
    pillar: string | null;
    angle: string | null;
    subjectStyle: string | null;
    sendHour: number | null;
    sent: number;
    openRate: number;
    clickRate: number;
    unsubRate: number;
  }>;
}

export interface TuningResult {
  recommendations: TuningRecommendations;
  topicWeights: Record<string, number>;
  subjectStyleWeights: Record<string, number>;
}

async function loadConfig(): Promise<TuningConfig> {
  const [minSample, explorationFloor, unsubCeiling] = await Promise.all([
    getSetting<number>("newsletter_tuning_min_sample", 50),
    getSetting<number>("newsletter_tuning_exploration_floor", 0.15),
    getSetting<number>("newsletter_tuning_unsub_ceiling", 0.005),
  ]);
  return {
    minSample: Number.isFinite(minSample) ? minSample : 50,
    explorationFloor: Number.isFinite(explorationFloor) ? explorationFloor : 0.15,
    unsubCeiling: Number.isFinite(unsubCeiling) ? unsubCeiling : 0.005,
  };
}

async function persist(key: string, value: unknown, adminId: string | null): Promise<void> {
  const { error } = await supabaseAdmin
    .from("system_settings")
    .update({ value, updated_by: adminId })
    .eq("key", key);
  if (error) {
    console.warn(`[newsletter-tuning] persist ${key} failed:`, error.message);
    return;
  }
  bustSettingCache(key);
}

/**
 * Run one analysis pass: aggregate → compute weights → persist. `nowMs` and
 * `nowIso` are passed in so callers control the clock; `actorId` stamps the
 * settings writes (a triggering admin, or null for the scheduled run).
 */
export async function recomputeNewsletterTuning(
  nowMs: number,
  nowIso: string,
  actorId: string | null,
): Promise<TuningResult> {
  const config = await loadConfig();
  const sinceIso = new Date(nowMs - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // 1. Pull the recently-sent recipient ledger (engagement signals).
  const { data: recipData } = await supabaseAdmin
    .from("newsletter_issue_recipients")
    .select("issue_id, opened_at, clicked_at, unsubscribed_at")
    .eq("status", "sent")
    .gte("created_at", sinceIso)
    .limit(RECIPIENT_SCAN_LIMIT);
  const recipients = (recipData ?? []) as RecipientRow[];

  // 2. Resolve the dimensions for the involved issues.
  const issueIds = [...new Set(recipients.map((r) => r.issue_id))];
  const dimsByIssue = new Map<string, IssueDims>();
  if (issueIds.length > 0) {
    const { data: issueData } = await supabaseAdmin
      .from("newsletter_issues")
      .select("id, pillar, angle, subject_style, send_hour")
      .in("id", issueIds);
    for (const row of (issueData ?? []) as Array<{ id: string } & IssueDims>) {
      dimsByIssue.set(row.id, {
        pillar: row.pillar,
        angle: row.angle,
        subject_style: row.subject_style,
        send_hour: row.send_hour,
      });
    }
  }

  const signals = (r: RecipientRow) => ({
    opened: !!r.opened_at || !!r.clicked_at, // a click implies an open
    clicked: !!r.clicked_at,
    unsubscribed: !!r.unsubscribed_at,
  });

  // 3a. Per-topic aggregation (keyed by catalog topic id, reconstructed from the
  //     issue's pillar+angle). Unknown pairs are skipped.
  const topicCounts = aggregateEngagement(
    recipients,
    (r) => {
      const d = dimsByIssue.get(r.issue_id);
      return topicByPillarAngle(d?.pillar ?? null, d?.angle ?? null)?.id ?? null;
    },
    signals,
  );
  const topicResult = computeWeights(NEWSLETTER_TOPICS.map((t) => t.id), topicCounts, config);

  // 3b. Per-subject-style aggregation.
  const styleCounts = aggregateEngagement(
    recipients,
    (r) => dimsByIssue.get(r.issue_id)?.subject_style ?? null,
    signals,
  );
  const styleResult = computeWeights(SUBJECT_STYLES.map((s) => s.id), styleCounts, config);

  // 3c. Per-send-hour aggregation.
  const hourCounts = aggregateEngagement(
    recipients,
    (r) => {
      const h = dimsByIssue.get(r.issue_id)?.send_hour;
      return typeof h === "number" ? String(h) : null;
    },
    signals,
  );
  const byHour: Record<number, ReturnType<typeof aggregateEngagement>[string]> = {};
  for (const [h, c] of Object.entries(hourCounts)) byHour[Number(h)] = c;
  const sendHour = recommendSendHour(byHour, config);

  // 3d. Per-issue rollup (transparency).
  const perIssueMap = new Map<string, { sent: number; opened: number; clicked: number; unsub: number }>();
  for (const r of recipients) {
    const agg = perIssueMap.get(r.issue_id) ?? { sent: 0, opened: 0, clicked: 0, unsub: 0 };
    agg.sent += 1;
    const s = signals(r);
    if (s.opened) agg.opened += 1;
    if (s.clicked) agg.clicked += 1;
    if (s.unsubscribed) agg.unsub += 1;
    perIssueMap.set(r.issue_id, agg);
  }
  const perIssue = [...perIssueMap.entries()]
    .map(([issueId, a]) => {
      const d = dimsByIssue.get(issueId);
      return {
        issueId,
        pillar: d?.pillar ?? null,
        angle: d?.angle ?? null,
        subjectStyle: d?.subject_style ?? null,
        sendHour: d?.send_hour ?? null,
        sent: a.sent,
        openRate: a.sent > 0 ? a.opened / a.sent : 0,
        clickRate: a.sent > 0 ? a.clicked / a.sent : 0,
        unsubRate: a.sent > 0 ? a.unsub / a.sent : 0,
      };
    })
    .sort((x, y) => y.sent - x.sent)
    .slice(0, 50);

  const recommendations: TuningRecommendations = {
    computedAt: nowIso,
    window: { days: WINDOW_DAYS, since: sinceIso },
    config,
    topicSent: topicResult.totalSent,
    topics: topicResult.scores,
    topicWinner: topicResult.winnerKey,
    pausedTopics: topicResult.paused,
    subjectStyles: styleResult.scores,
    subjectWinner: styleResult.winnerKey,
    sendHour,
    perIssue,
  };

  // 4. Persist the computed stores + the recommendations snapshot.
  await persist("newsletter_topic_weights", topicResult.weights, actorId);
  await persist("newsletter_subject_style_weights", styleResult.weights, actorId);
  await persist("newsletter_send_hour_stats", sendHour, actorId);
  await persist("newsletter_tuning_recommendations", recommendations, actorId);

  return {
    recommendations,
    topicWeights: topicResult.weights,
    subjectStyleWeights: styleResult.weights,
  };
}
