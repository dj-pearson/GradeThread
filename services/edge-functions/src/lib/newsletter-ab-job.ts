// US-927: Subject-line A/B testing — DB-touching orchestration.
//
// Two phases, resumable + idempotent on the durable ledger:
//   1. startAbTest      — send the test holdout (variants assigned), mark the
//                         issue `sending` / ab_phase `testing`, stamp the clock.
//   2. finalizeAbTest   — after the measurement window, roll up per-variant
//                         engagement, pick the winner (operator override → auto →
//                         min-sample fallback), send the winner to the remainder,
//                         mark the issue `sent` / ab_phase `completed`.
//
// Every send routes through coordinateMarketingSend (consent + suppression +
// frequency cap + drip precedence + durable outbox), so the A/B flow inherits the
// same delivery + idempotency guarantees as the plain newsletter send. Kept out of
// the route file so the route stays thin and this is reusable by the finalize cron.

import { supabaseAdmin } from "./supabase.ts";
import { fetchAllPages } from "./paged-read.ts";
import { getSetting } from "./system-settings.ts";
import { captureException } from "./observability.ts";
import { coordinateMarketingSend } from "./marketing-coordinator.ts";
import { marketingPreferenceCenterUrl, marketingUnsubscribeUrl } from "./unsubscribe.ts";
import {
  type NewsletterSection,
  renderNewsletterHtml,
} from "./newsletter-issue.ts";
import {
  personalizeIssueSections,
  type RecipientActivity,
  substituteTokens,
} from "./newsletter-personalization.ts";
import { resolvePersonalizationForBatch } from "./newsletter-personalization-job.ts";
import { isUniqueViolation, verdictForExistingRow } from "./campaign-claim.ts";
import {
  type AbConfig,
  type AbMetric,
  aggregateVariantStats,
  assignVariant,
  clampAbConfig,
  hasAbTest,
  isMeasurementWindowElapsed,
  normalizeVariants,
  planHoldout,
  type RecipientSignals,
  selectAbWinner,
  type SubjectVariant,
  variantById,
} from "./newsletter-ab.ts";

// US-2316 AC4: `MAX_SEND_RECIPIENTS = 1000` was deleted here. It capped three
// reads and every one of them was wrong in a different way — the confirmed
// subscriber list (subscriber 1001 never received an issue), the already-sent
// ledger (a truncated tail is emailed twice) and the holdout stats (a winner
// chosen from an arbitrary sample). None had an ORDER BY either, so WHICH rows
// fell outside the cap changed between runs, which is why nobody was
// consistently missing and nobody complained twice. All three now page.

function postalAddress(): string {
  return Deno.env.get("COMPANY_POSTAL_ADDRESS")?.trim() || "Pearson Media LLC, Iowa, USA";
}

// The subset of newsletter_issues columns the A/B orchestration needs.
const AB_ISSUE_COLS =
  "id, title, subject, preheader, sections, status, subject_variants, ab_metric, " +
  "ab_test_fraction, ab_measurement_hours, ab_phase, ab_test_started_at, " +
  "ab_winner_variant, ab_winner_source, personalize";

export interface AbIssueRow {
  id: string;
  title: string;
  subject: string;
  preheader: string | null;
  sections: NewsletterSection[];
  status: string;
  subject_variants: unknown;
  ab_metric: AbMetric;
  ab_test_fraction: number | null;
  ab_measurement_hours: number | null;
  ab_phase: "none" | "testing" | "completed";
  ab_test_started_at: string | null;
  ab_winner_variant: string | null;
  ab_winner_source: "auto" | "operator" | "fallback" | null;
  /** US-921: per-issue personalization toggle (default true). */
  personalize?: boolean | null;
}

export async function loadAbIssue(id: string): Promise<AbIssueRow | null> {
  const { data, error } = await supabaseAdmin
    .from("newsletter_issues")
    .select(AB_ISSUE_COLS)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    captureException(error, { tags: { area: "newsletter-ab" } });
    return null;
  }
  return (data as unknown as AbIssueRow | null) ?? null;
}

/** Resolve the operator-tunable A/B config from the registry, merged with per-issue overrides. */
export async function resolveAbConfig(issue?: Pick<AbIssueRow, "ab_test_fraction" | "ab_measurement_hours">): Promise<AbConfig> {
  const [enabled, fraction, hours, minSample] = await Promise.all([
    getSetting<boolean>("newsletter_ab_test_enabled", true),
    getSetting<number>("newsletter_ab_test_fraction", 0.2),
    getSetting<number>("newsletter_ab_measurement_hours", 4),
    getSetting<number>("newsletter_ab_min_sample", 50),
  ]);
  return clampAbConfig({
    enabled: Boolean(enabled),
    testFraction: issue?.ab_test_fraction ?? fraction,
    measurementHours: issue?.ab_measurement_hours ?? hours,
    minSample,
  });
}

/** True when this issue should run an A/B test rather than a plain single send. */
export function issueWantsAbTest(issue: AbIssueRow, config: AbConfig): boolean {
  if (!config.enabled) return false;
  const variants = normalizeVariants(issue.subject_variants, issue.subject);
  return hasAbTest(variants);
}

// ── Per-recipient delivery (shared by both phases) ────────────────────────────

export interface DeliverResult {
  outcome: "sent" | "skipped" | "failed";
  reason?: string;
}

/**
 * Render + gate + deliver one issue email and record the per-issue ledger row
 * (with the variant + holdout flag). Returns the outcome for counter rollup.
 *
 * US-2316 AC4: CLAIM → SEND → FINALISE, not send-then-record.
 *
 * This used to send and THEN upsert the ledger row, so a container death
 * between the two left no row at all — and `loadLedgerEmails` builds the next
 * tick's skip set from that table, so the recipient came back round and was
 * mailed a second time. Marketing mail is the one place a duplicate is not a
 * private embarrassment: it lands in the inbox of someone who can report it,
 * and the platform-wide 1/day frequency cap is a policy control that was never
 * meant to be the idempotency mechanism.
 *
 * The claim is an INSERT, never an upsert. An upsert ALWAYS SUCCEEDS, which is
 * exactly why it cannot pick a winner — the campaign path made that mistake and
 * US-2316 AC2 fixed it there. The unique index on (issue_id, email) decides,
 * atomically, in the database; the loser gets 23505 and asks what the existing
 * row means (`verdictForExistingRow`, shared with the campaign path so the two
 * cannot drift).
 *
 * ⚠ THE SAME DELIBERATE TRADE as the campaign path, restated because it is a
 * real cost: a row left at `pending` is never re-sent. A worker that dies
 * between claiming and sending loses that recipient until someone sets the row
 * to `failed`, which a later tick will reclaim. Reclaiming stale `pending` rows
 * on a timer was rejected there for a reason that holds here — nothing on the
 * row distinguishes "claimed by a worker that died" from "claimed by a worker
 * still working", and a pending→pending reclaim cannot be made exclusive, so
 * both racers would win it and the duplicate would be back.
 */
export async function deliverIssueRecipient(params: {
  issue: Pick<AbIssueRow, "id" | "title" | "preheader" | "sections">;
  recipient: { email: string; user_id: string | null };
  subjectLine: string;
  variantId: string | null;
  isHoldout: boolean;
  /** US-921: when set, inject the per-recipient recap + tailored CTA and
   *  token-substitute the copy. Omit / null ⇒ the issue's plain body is sent. */
  personalization?: {
    activity: RecipientActivity | null;
    siteUrl?: string;
    trialSoonDays?: number;
  } | null;
}): Promise<DeliverResult> {
  const { issue, recipient, subjectLine, variantId, isHoldout, personalization } = params;

  // Standalone leads with no linked account can't get a consent check or a signed
  // unsubscribe link — skip with a recorded reason.
  if (!recipient.user_id) {
    await supabaseAdmin.from("newsletter_issue_recipients").upsert({
      issue_id: issue.id,
      email: recipient.email,
      status: "skipped",
      skip_reason: "no_account",
      variant: variantId,
      is_ab_holdout: isHoldout,
    }, { onConflict: "issue_id,email", ignoreDuplicates: true });
    return { outcome: "skipped", reason: "no_account" };
  }

  // ── CLAIM ────────────────────────────────────────────────────────────────
  const { error: claimErr } = await supabaseAdmin
    .from("newsletter_issue_recipients")
    .insert({
      issue_id: issue.id,
      email: recipient.email,
      subscriber_user_id: recipient.user_id,
      status: "pending",
      variant: variantId,
      is_ab_holdout: isHoldout,
    });

  if (claimErr) {
    if (!isUniqueViolation(claimErr)) {
      // Not a lost race — the ledger is unwritable. Refuse to send: an email we
      // cannot record is one we cannot stop sending again. Treating this as a
      // lost claim would be worse in the other direction (silently dropping
      // recipients on a transient database error), so it is reported as failed.
      captureException(claimErr, { tags: { area: "newsletter-ab.claim" } });
      return { outcome: "failed", reason: "claim_error" };
    }
    const { data: existing } = await supabaseAdmin
      .from("newsletter_issue_recipients")
      .select("status")
      .eq("issue_id", issue.id)
      .eq("email", recipient.email)
      .maybeSingle();
    const verdict = verdictForExistingRow(existing as { status: string } | null);

    if (verdict.action === "already") {
      // Recorded on an earlier tick. Counted at its recorded status so the
      // rollup stays truthful rather than reporting a fresh send.
      return { outcome: verdict.status, reason: "already_recorded" };
    }
    if (verdict.action === "in_flight") {
      return { outcome: "skipped", reason: "in_flight" };
    }
    // reclaim: a previous attempt failed. Take it back CONDITIONALLY —
    // `.eq("status", "failed")` is what makes the reclaim exclusive, so two
    // ticks racing the same failed row cannot both proceed to send.
    const { data: reclaimed } = await supabaseAdmin
      .from("newsletter_issue_recipients")
      .update({ status: "pending" })
      .eq("issue_id", issue.id)
      .eq("email", recipient.email)
      .eq("status", verdict.from)
      .select("email")
      .maybeSingle();
    if (!reclaimed) return { outcome: "skipped", reason: "in_flight" };
  }

  try {
    const [unsubscribeUrl, preferenceCenterUrl] = await Promise.all([
      marketingUnsubscribeUrl(recipient.user_id),
      marketingPreferenceCenterUrl(recipient.user_id),
    ]);
    const baseSections = Array.isArray(issue.sections) ? issue.sections : [];
    let renderSections = baseSections;
    let renderSubject = subjectLine;
    if (personalization) {
      const p = personalizeIssueSections(baseSections, personalization.activity, {
        siteUrl: personalization.siteUrl,
        trialSoonDays: personalization.trialSoonDays,
      });
      renderSections = p.sections;
      renderSubject = substituteTokens(subjectLine, p.tokens);
    }
    const html = renderNewsletterHtml(
      { subject: renderSubject, preheader: issue.preheader, sections: renderSections },
      { unsubscribeUrl, preferenceCenterUrl, postalAddress: postalAddress() },
    );
    const result = await coordinateMarketingSend({
      to: recipient.email,
      userId: recipient.user_id,
      source: "weekly_newsletter",
      category: `newsletter:${issue.id}`,
      subject: renderSubject || issue.title,
      html,
    });

    if (result.action === "drop") {
      // FINALISE. An UPDATE, because the row is already ours — an upsert here
      // would happily recreate a row someone else had finalised.
      await supabaseAdmin
        .from("newsletter_issue_recipients")
        .update({ status: "skipped", skip_reason: result.reason })
        .eq("issue_id", issue.id)
        .eq("email", recipient.email);
      return { outcome: "skipped", reason: result.reason };
    }

    // send or defer — both durably accepted.
    await supabaseAdmin
      .from("newsletter_issue_recipients")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("issue_id", issue.id)
      .eq("email", recipient.email);
    return { outcome: "sent" };
  } catch (err) {
    captureException(err, { tags: { area: "newsletter-ab.deliver" } });
    // Left at `failed`, not deleted: a later tick RECLAIMS a failed row, which
    // is how a transient send error becomes a retry instead of a lost recipient.
    await supabaseAdmin
      .from("newsletter_issue_recipients")
      .update({ status: "failed" })
      .eq("issue_id", issue.id)
      .eq("email", recipient.email);
    return { outcome: "failed" };
  }
}

// US-921: per-recipient personalization param from a resolved batch context.
type PersonalizationCtx = Awaited<ReturnType<typeof resolvePersonalizationForBatch>>;
function personalizationFor(ctx: PersonalizationCtx, userId: string | null) {
  if (!ctx.enabled) return null;
  return {
    activity: userId ? ctx.activity.get(userId) ?? null : null,
    siteUrl: ctx.siteUrl,
    trialSoonDays: ctx.trialSoonDays,
  };
}

/**
 * US-2316 AC4 (first half): every confirmed subscriber, in a stable order.
 *
 * This was a single `.limit(MAX_SEND_RECIPIENTS)` with NO `.order()`, and both
 * halves of that were bugs. The cap meant subscriber 1001 never received an
 * issue — not "received it late", never — and without an ORDER BY the server may
 * return rows in a different order per request, so WHICH 1000 got the newsletter
 * was unstable between runs. The missing subscribers were therefore different
 * every week, which is precisely the shape nobody notices: no one is
 * consistently missing, so no one complains twice.
 *
 * `fetchAllPages` advances by rows RETURNED and stops only on an empty response,
 * so it is also immune to the PostgREST `db-max-rows` ceiling that would clip a
 * single large read with error:null.
 */
async function resolveConfirmed(): Promise<{ email: string; user_id: string | null }[]> {
  try {
    return await fetchAllPages<{ email: string; user_id: string | null }>(
      async (from, to) => {
        const { data, error } = await supabaseAdmin
          .from("email_subscribers")
          .select("email, user_id")
          .eq("status", "confirmed")
          // Required for paging to be stable: without it a page boundary can
          // skip a row entirely, which is the same missing-subscriber bug in a
          // new costume.
          .order("email", { ascending: true })
          .range(from, to);
        if (error) throw new Error(`confirmed-subscriber read failed: ${error.message}`);
        return (data ?? []) as { email: string; user_id: string | null }[];
      },
    );
  } catch (err) {
    captureException(err, { tags: { area: "newsletter-ab.resolve" } });
    return [];
  }
}

export interface PhaseSummary {
  sent: number;
  skipped: number;
  failed: number;
}

function tally(results: DeliverResult[]): PhaseSummary {
  const s: PhaseSummary = { sent: 0, skipped: 0, failed: 0 };
  for (const r of results) {
    if (r.outcome === "sent") s.sent++;
    else if (r.outcome === "skipped") s.skipped++;
    else s.failed++;
  }
  return s;
}

// ── Phase 1: start the A/B test (send the holdout) ────────────────────────────

export interface StartResult {
  ok: boolean;
  reason?: string;
  variants: SubjectVariant[];
  holdoutSize: number;
  remainderSize: number;
  summary: PhaseSummary;
}

/**
 * Send the A/B test holdout for an approved issue: resolve the confirmed list,
 * plan the holdout, assign a variant to each holdout recipient (deterministic),
 * deliver, then lock the issue into `sending` / ab_phase `testing` so the finalize
 * pass picks it up after the measurement window.
 */
export async function startAbTest(issue: AbIssueRow, config: AbConfig): Promise<StartResult> {
  const variants = normalizeVariants(issue.subject_variants, issue.subject);
  if (!hasAbTest(variants)) {
    return { ok: false, reason: "no_variants", variants, holdoutSize: 0, remainderSize: 0, summary: { sent: 0, skipped: 0, failed: 0 } };
  }

  const recipients = await resolveConfirmed();
  // Deterministic order so a re-run picks the same holdout subset.
  recipients.sort((a, b) => a.email.localeCompare(b.email));
  const plan = planHoldout(recipients.length, config.testFraction);

  if (plan.holdoutSize < 1) {
    return { ok: false, reason: "list_too_small", variants, holdoutSize: 0, remainderSize: plan.remainderSize, summary: { sent: 0, skipped: 0, failed: 0 } };
  }

  const holdout = recipients.slice(0, plan.holdoutSize);
  const pctx = await resolvePersonalizationForBatch(holdout, issue.personalize !== false, Date.now());

  // Lock the issue + clear any prior ledger (fresh, idempotent test start).
  await supabaseAdmin
    .from("newsletter_issues")
    .update({
      status: "sending",
      ab_phase: "testing",
      ab_test_started_at: new Date().toISOString(),
      ab_winner_variant: null,
      ab_winner_source: null,
      send_started_at: new Date().toISOString(),
      recipients_total: recipients.length,
      sent_count: 0,
      skipped_count: 0,
      failed_count: 0,
    })
    .eq("id", issue.id);
  await supabaseAdmin.from("newsletter_issue_recipients").delete().eq("issue_id", issue.id);

  const results: DeliverResult[] = [];
  for (const r of holdout) {
    const variant = assignVariant(variants, r.email);
    results.push(
      await deliverIssueRecipient({
        issue,
        recipient: r,
        subjectLine: variant.subject,
        variantId: variant.id,
        isHoldout: true,
        personalization: personalizationFor(pctx, r.user_id),
      }),
    );
  }
  const summary = tally(results);

  await supabaseAdmin
    .from("newsletter_issues")
    .update({ sent_count: summary.sent, skipped_count: summary.skipped, failed_count: summary.failed })
    .eq("id", issue.id);

  return { ok: true, variants, holdoutSize: plan.holdoutSize, remainderSize: plan.remainderSize, summary };
}

// ── Phase 2: finalize (select winner, send remainder) ─────────────────────────

export interface FinalizeResult {
  ok: boolean;
  reason?: string;
  winnerId: string | null;
  winnerSource: "auto" | "operator" | "fallback" | null;
  metric: AbMetric;
  scores: Array<{ variantId: string; sent: number; rate: number; trusted: boolean }>;
  remainderSummary: PhaseSummary;
}

/**
 * Finalize a testing issue: aggregate holdout engagement, pick the winner, send
 * the winning subject to the remainder, mark the issue sent. `force` skips the
 * measurement-window wait (operator "finalize now"). Honors an operator winner
 * override (ab_winner_source already 'operator' with a valid ab_winner_variant).
 */
export async function finalizeAbTest(
  issue: AbIssueRow,
  config: AbConfig,
  nowMs: number,
  opts: { force?: boolean } = {},
): Promise<FinalizeResult> {
  const variants = normalizeVariants(issue.subject_variants, issue.subject);
  if (issue.ab_phase !== "testing") {
    return { ok: false, reason: "not_testing", winnerId: null, winnerSource: null, metric: issue.ab_metric, scores: [], remainderSummary: { sent: 0, skipped: 0, failed: 0 } };
  }
  if (!opts.force && !isMeasurementWindowElapsed(issue.ab_test_started_at, config.measurementHours, nowMs)) {
    return { ok: false, reason: "window_not_elapsed", winnerId: null, winnerSource: null, metric: issue.ab_metric, scores: [], remainderSummary: { sent: 0, skipped: 0, failed: 0 } };
  }

  // Roll up per-variant engagement from the holdout ledger.
  // US-2316 AC4: paged. A cap here does not duplicate email, it SKEWS the
  // winner — the variant stats would be computed from an arbitrary 1000 of the
  // holdout, and the subject line chosen from that sample ships to everyone.
  const holdoutRows = await fetchAllPages<
    { variant: string | null; opened_at: string | null; clicked_at: string | null }
  >(async (from, to) => {
    const { data, error } = await supabaseAdmin
      .from("newsletter_issue_recipients")
      .select("variant, opened_at, clicked_at")
      .eq("issue_id", issue.id)
      .eq("is_ab_holdout", true)
      .order("email", { ascending: true })
      .range(from, to);
    if (error) throw new Error(`holdout read failed: ${error.message}`);
    return (data ?? []) as Array<
      { variant: string | null; opened_at: string | null; clicked_at: string | null }
    >;
  });
  const signals: RecipientSignals[] = ((holdoutRows ?? []) as Array<{ variant: string | null; opened_at: string | null; clicked_at: string | null }>)
    .map((r) => ({ variant: r.variant, opened: !!r.opened_at, clicked: !!r.clicked_at }));
  const stats = aggregateVariantStats(variants, signals);

  // Winner: operator override wins; else auto-select (min-sample → fallback).
  const operatorOverride = issue.ab_winner_source === "operator" &&
    variantById(variants, issue.ab_winner_variant) !== null;
  let winnerId: string;
  let winnerSource: "auto" | "operator" | "fallback";
  let metric: AbMetric = issue.ab_metric;
  let scores: WinnerScores = [];
  if (operatorOverride) {
    winnerId = issue.ab_winner_variant!;
    winnerSource = "operator";
    scores = stats.map((s) => ({ variantId: s.variantId, sent: s.sent, rate: 0, trusted: false }));
  } else {
    const result = selectAbWinner(variants, stats, {
      metric: issue.ab_metric,
      minSample: config.minSample,
      fallbackVariantId: variants[0]?.id ?? null,
    });
    winnerId = result.winnerId;
    winnerSource = result.source;
    metric = result.metric;
    scores = result.scores;
  }

  const winner = variantById(variants, winnerId) ?? variants[0]!;

  // Send the winning subject to the remainder (everyone confirmed not already in
  // the ledger). Re-resolving + excluding the holdout keeps it idempotent.
  // US-2316 AC4: paged, and this is the one that DUPLICATES. It is the
  // already-sent set for phase 2; a truncated read drops its tail and every
  // recipient in that tail is emailed the winning subject a second time.
  const ledgerRows = await fetchAllPages<{ email: string }>(async (from, to) => {
    const { data, error } = await supabaseAdmin
      .from("newsletter_issue_recipients")
      .select("email")
      // US-2316 AC4: a `failed` row is NOT an exclusion — it is the retry
      // handle. Excluding every row regardless of status made `failed` a
      // tombstone: a recipient whose send threw once was never offered again,
      // and the reclaim arm in deliverIssueRecipient could never be reached.
      // Retrying is exclusive (the reclaim is conditional on the status it
      // read), so two ticks cannot both take one failed row.
      .neq("status", "failed")
      .eq("issue_id", issue.id)
      .order("email", { ascending: true })
      .range(from, to);
    if (error) throw new Error(`ledger read failed: ${error.message}`);
    return (data ?? []) as Array<{ email: string }>;
  });
  const alreadySent = new Set(((ledgerRows ?? []) as { email: string }[]).map((r) => r.email.toLowerCase()));

  const confirmed = await resolveConfirmed();
  const remainder = confirmed.filter((r) => !alreadySent.has(r.email.toLowerCase()));
  const pctx = await resolvePersonalizationForBatch(remainder, issue.personalize !== false, nowMs);

  const results: DeliverResult[] = [];
  for (const r of remainder) {
    results.push(
      await deliverIssueRecipient({
        issue,
        recipient: r,
        subjectLine: winner.subject,
        variantId: winner.id,
        isHoldout: false,
        personalization: personalizationFor(pctx, r.user_id),
      }),
    );
  }
  const remainderSummary = tally(results);

  // Roll the remainder into the issue counters + mark sent. The winning subject
  // becomes the issue's recorded subject (what most recipients got).
  const { data: prior } = await supabaseAdmin
    .from("newsletter_issues")
    .select("sent_count, skipped_count, failed_count")
    .eq("id", issue.id)
    .maybeSingle();
  const p = (prior ?? { sent_count: 0, skipped_count: 0, failed_count: 0 }) as { sent_count: number; skipped_count: number; failed_count: number };

  await supabaseAdmin
    .from("newsletter_issues")
    .update({
      status: "sent",
      ab_phase: "completed",
      ab_winner_variant: winnerId,
      ab_winner_source: winnerSource,
      subject: winner.subject,
      sent_at: new Date().toISOString(),
      sent_count: (p.sent_count ?? 0) + remainderSummary.sent,
      skipped_count: (p.skipped_count ?? 0) + remainderSummary.skipped,
      failed_count: (p.failed_count ?? 0) + remainderSummary.failed,
    })
    .eq("id", issue.id);

  return { ok: true, winnerId, winnerSource, metric, scores, remainderSummary };
}

type WinnerScores = Array<{ variantId: string; sent: number; rate: number; trusted: boolean }>;

// ── Cron scan: finalize all due testing issues ────────────────────────────────

export interface ScanResult {
  scanned: number;
  finalized: number;
  details: Array<{ issueId: string; winnerId: string | null; source: string | null; remainderSent: number }>;
}

/**
 * Find issues whose A/B measurement window has elapsed and finalize each. Called
 * by the scheduled cron so the whole flow is autonomous — no human picks a winner.
 */
export async function scanAndFinalizeDueAbTests(nowMs: number): Promise<ScanResult> {
  const { data, error } = await supabaseAdmin
    .from("newsletter_issues")
    .select(AB_ISSUE_COLS)
    .eq("ab_phase", "testing")
    .limit(50);
  if (error) {
    captureException(error, { tags: { area: "newsletter-ab.scan" } });
    return { scanned: 0, finalized: 0, details: [] };
  }
  const rows = (data ?? []) as unknown as AbIssueRow[];

  const details: ScanResult["details"] = [];
  let finalized = 0;
  for (const issue of rows) {
    const config = await resolveAbConfig(issue);
    if (!isMeasurementWindowElapsed(issue.ab_test_started_at, config.measurementHours, nowMs)) continue;
    const result = await finalizeAbTest(issue, config, nowMs);
    if (result.ok) {
      finalized++;
      details.push({
        issueId: issue.id,
        winnerId: result.winnerId,
        source: result.winnerSource,
        remainderSent: result.remainderSummary.sent,
      });
    }
  }
  return { scanned: rows.length, finalized, details };
}
