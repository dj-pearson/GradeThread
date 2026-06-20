// US-924: Autonomous pre-send QA / guardrail gate — orchestration (impure).
//
// Glues the PURE guardrail logic (newsletter-qa.ts) + the AI editor pass
// (newsletter-ai-editor.ts) to the DB and ops alerting, then drives the issue to
// its next status:
//   • any hard failure (QA or AI)        → blocked + ops alert
//   • AI inconclusive OR require-approval → awaiting_review
//   • otherwise                           → approved (autonomous auto-send)
//
// Reusable from both the admin console route (operator-triggered) and the
// autonomous engine (sibling story) — pass actorUserId for an operator run, or
// null for the unattended pipeline. The full per-check report is persisted to
// newsletter_issues.qa_results so the console renders exactly what the gate saw.

import { supabaseAdmin } from "./supabase.ts";
import { getSetting } from "./system-settings.ts";
import { captureException } from "./observability.ts";
import { emitOpsEvent } from "./ops-events.ts";
import { fetchWithTimeout } from "./circuit-breaker.ts";
import { marketingPreferenceCenterUrl, marketingUnsubscribeUrl } from "./unsubscribe.ts";
import {
  type NewsletterSection,
  type RenderableIssue,
  renderNewsletterHtml,
  renderNewsletterText,
} from "./newsletter-issue.ts";
import {
  type AiEditorResult,
  runAiEditorPass,
} from "./newsletter-ai-editor.ts";
import {
  decideGateOutcome,
  DEFAULT_QA_THRESHOLDS,
  extractLinks,
  type GateOutcome,
  type GuardrailCheck,
  type GuardrailReport,
  isAbsoluteLink,
  type QaContext,
  type QaThresholds,
  runGuardrailQa,
} from "./newsletter-qa.ts";

interface GateIssueRow {
  id: string;
  subject: string;
  preheader: string | null;
  sections: NewsletterSection[];
  status: string;
}

const GATE_COLS = "id, subject, preheader, sections, status";

// Issues the gate may run on (pre-send states only — never a sending/sent issue).
const GATEABLE_STATUSES = new Set([
  "draft",
  "ready_for_qa",
  "awaiting_review",
  "approved",
]);

export interface GuardrailGateResult {
  outcome: GateOutcome;
  reasons: string[];
  qaReport: GuardrailReport;
  aiEditor: AiEditorResult;
}

// Load the operator-tunable thresholds from the settings registry (seeded 00284).
async function loadQaThresholds(): Promise<QaThresholds> {
  const [spamMax, subjectMax, preheaderMax, requirePref] = await Promise.all([
    getSetting<number>("newsletter_qa_spam_score_max", DEFAULT_QA_THRESHOLDS.spamScoreMax),
    getSetting<number>("newsletter_qa_subject_max_length", DEFAULT_QA_THRESHOLDS.subjectMaxLength),
    getSetting<number>("newsletter_qa_preheader_max_length", DEFAULT_QA_THRESHOLDS.preheaderMaxLength),
    getSetting<boolean>("newsletter_qa_require_preference_center", DEFAULT_QA_THRESHOLDS.requirePreferenceCenter),
  ]);
  return {
    spamScoreMax: Number.isFinite(spamMax) ? Number(spamMax) : DEFAULT_QA_THRESHOLDS.spamScoreMax,
    subjectMaxLength: Number.isFinite(subjectMax) ? Number(subjectMax) : DEFAULT_QA_THRESHOLDS.subjectMaxLength,
    preheaderMaxLength: Number.isFinite(preheaderMax)
      ? Number(preheaderMax)
      : DEFAULT_QA_THRESHOLDS.preheaderMaxLength,
    requirePreferenceCenter: Boolean(requirePref),
  };
}

function toRenderable(row: GateIssueRow): RenderableIssue {
  return {
    subject: row.subject,
    preheader: row.preheader,
    sections: Array.isArray(row.sections) ? row.sections : [],
  };
}

// Best-effort live link resolution: classify each unique absolute link as
// ok / broken / inconclusive. A confirmed 4xx/5xx is "broken" (blocks); a
// network error/timeout is "inconclusive" (never blocks on transient failures).
// Bounded to the first N links so the gate stays fast.
const LINK_CHECK_LIMIT = 15;
const LINK_CHECK_TIMEOUT_MS = 6000;

async function resolveLinks(urls: string[]): Promise<Record<string, "ok" | "broken" | "inconclusive">> {
  const out: Record<string, "ok" | "broken" | "inconclusive"> = {};
  const targets = urls
    .filter((u) => /^https?:\/\//i.test(u) && isAbsoluteLink(u))
    .slice(0, LINK_CHECK_LIMIT);
  await Promise.all(
    targets.map(async (url) => {
      try {
        let res = await fetchWithTimeout(url, { method: "HEAD", redirect: "follow" }, LINK_CHECK_TIMEOUT_MS);
        // Some hosts reject HEAD (405) — retry with GET before judging.
        if (res.status === 405 || res.status === 501) {
          await res.body?.cancel();
          res = await fetchWithTimeout(url, { method: "GET", redirect: "follow" }, LINK_CHECK_TIMEOUT_MS);
        }
        const status = res.status;
        await res.body?.cancel();
        out[url] = status >= 400 ? "broken" : "ok";
      } catch {
        out[url] = "inconclusive";
      }
    }),
  );
  return out;
}

/**
 * Run the autonomous pre-send guardrail gate on one issue and transition it.
 * Returns null only when the issue can't be loaded or isn't in a gateable state.
 */
export async function runIssueGuardrailGate(
  issueId: string,
  opts: { actorUserId?: string | null } = {},
): Promise<GuardrailGateResult | null> {
  const { data, error } = await supabaseAdmin
    .from("newsletter_issues")
    .select(GATE_COLS)
    .eq("id", issueId)
    .maybeSingle();
  if (error) {
    captureException(error, { tags: { area: "newsletter-qa-job" } });
    return null;
  }
  const row = (data as unknown as GateIssueRow | null) ?? null;
  if (!row || !GATEABLE_STATUSES.has(row.status)) return null;

  const renderable = toRenderable(row);
  const thresholds = await loadQaThresholds();

  // Render the issue exactly as it will go out (footer compliance links + a real
  // postal address) so the structural scan sees the same HTML the recipient does.
  const postalAddress = Deno.env.get("COMPANY_POSTAL_ADDRESS")?.trim() || "Pearson Media LLC, Iowa, USA";
  // A representative signed unsubscribe URL (the per-recipient one is minted at
  // send time; the gate only needs to confirm the link is PRESENT + absolute).
  const unsubscribeUrl = await marketingUnsubscribeUrl(row.id).catch(
    () => "https://functions.gradethread.com/api/notifications/unsubscribe?u=preview&t=preview",
  );
  const preferenceCenterUrl = marketingPreferenceCenterUrl();
  const html = renderNewsletterHtml(renderable, { unsubscribeUrl, preferenceCenterUrl, postalAddress });
  const plaintext = renderNewsletterText(renderable);

  // Optional live link-resolution pass (operator-gated; default on).
  let linkStatuses: Record<string, "ok" | "broken" | "inconclusive"> | undefined;
  if (await getSetting<boolean>("newsletter_qa_link_check_enabled", true)) {
    const ctaUrls = renderable.sections.map((s) => s.ctaUrl ?? "").filter(Boolean);
    const links = extractLinks(html, ctaUrls);
    try {
      linkStatuses = await resolveLinks(links);
    } catch (err) {
      captureException(err, { tags: { area: "newsletter-qa-job.links" } });
    }
  }

  const ctx: QaContext = {
    html,
    plaintext,
    hasUnsubscribe: Boolean(unsubscribeUrl),
    hasPreferenceCenter: Boolean(preferenceCenterUrl),
    hasPostalAddress: Boolean(postalAddress),
    linkStatuses,
  };

  const qaReport = runGuardrailQa(renderable, ctx, thresholds);

  // AI editor pass (brand voice + factual grounding), operator-gated.
  const aiEnabled = await getSetting<boolean>("newsletter_qa_ai_editor_enabled", true);
  const aiEditor: AiEditorResult = aiEnabled
    ? await runAiEditorPass(renderable, { userId: opts.actorUserId ?? null })
    : { ran: true, hardFlag: false, brandVoiceOk: true, flags: [], summary: "AI editor disabled" };

  const decision = decideGateOutcome({
    qaPassed: qaReport.passed,
    aiHardFlag: aiEditor.hardFlag,
    aiInconclusive: aiEnabled && !aiEditor.ran,
    requireApproval: await getSetting<boolean>("newsletter_require_approval", true),
  });

  const ranAt = new Date().toISOString();
  const mergedChecks = buildMergedChecks(qaReport, aiEditor, aiEnabled);
  const storedReport = {
    passed: qaReport.passed && !aiEditor.hardFlag,
    checks: mergedChecks,
    spamScore: qaReport.spamScore,
    failureReasons: [...qaReport.failureReasons, ...(aiEditor.hardFlag ? aiEditor.flags.filter((f) => f.severity === "hard").map((f) => f.detail) : [])],
    aiEditor: {
      ran: aiEditor.ran,
      hardFlag: aiEditor.hardFlag,
      brandVoiceOk: aiEditor.brandVoiceOk,
      flags: aiEditor.flags,
      summary: aiEditor.summary,
      error: aiEditor.error,
    },
    outcome: decision.outcome,
    decisionReasons: decision.reasons,
    ranAt,
  };

  // Persist the report + transition.
  const patch: Record<string, unknown> = {
    qa_results: storedReport,
    status: decision.outcome,
  };
  if (decision.outcome === "blocked") {
    patch.block_reason = decision.reasons.concat(storedReport.failureReasons).slice(0, 6).join("; ") ||
      "Blocked by pre-send QA gate";
  } else {
    patch.block_reason = null;
  }
  if (decision.outcome === "approved") {
    patch.approved_by = opts.actorUserId ?? null;
    patch.approved_at = ranAt;
  }

  const { error: upErr } = await supabaseAdmin
    .from("newsletter_issues")
    .update(patch)
    .eq("id", row.id);
  if (upErr) {
    captureException(upErr, { tags: { area: "newsletter-qa-job.persist" } });
  }

  // Raise an ops alert on a block so the autonomous pipeline never fails silently.
  if (decision.outcome === "blocked") {
    await emitOpsEvent("newsletter.qa", "warning", {
      title: `Newsletter issue blocked by pre-send QA gate`,
      source: "newsletter-qa-gate",
      actorUserId: opts.actorUserId ?? null,
      data: {
        issueId: row.id,
        reasons: decision.reasons,
        failedChecks: mergedChecks.filter((c) => c.severity === "hard" && !c.passed).map((c) => c.id),
        spamScore: qaReport.spamScore,
        aiHardFlag: aiEditor.hardFlag,
      },
    });
  }

  return { outcome: decision.outcome, reasons: decision.reasons, qaReport, aiEditor };
}

// Merge the structural checks with one row per AI-editor flag (+ a summary row)
// so the console renders the AI verdict alongside the compliance checks.
function buildMergedChecks(
  qaReport: GuardrailReport,
  aiEditor: AiEditorResult,
  aiEnabled: boolean,
): GuardrailCheck[] {
  const checks: GuardrailCheck[] = [...qaReport.checks];
  if (!aiEnabled) return checks;
  if (!aiEditor.ran) {
    checks.push({
      id: "ai_editor",
      label: "AI editor: brand voice + factual grounding",
      passed: false,
      severity: "soft",
      detail: "Inconclusive (model unavailable) — routed to human review",
    });
    return checks;
  }
  checks.push({
    id: "ai_editor",
    label: "AI editor: brand voice + factual grounding",
    passed: !aiEditor.hardFlag,
    severity: "hard",
    detail: aiEditor.summary || (aiEditor.hardFlag ? "Hard flag raised" : "Clean"),
  });
  aiEditor.flags.forEach((f, i) => {
    checks.push({
      id: `ai_${f.type}_${i}`,
      label: `AI ${f.type.replace("_", " ")} flag`,
      passed: f.severity !== "hard",
      severity: f.severity,
      detail: f.detail,
    });
  });
  return checks;
}
