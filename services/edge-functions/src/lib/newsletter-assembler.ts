// US-922: Autonomous weekly issue ASSEMBLER — the single orchestrator that builds
// the week's issue end-to-end with zero human input. Shared by the admin console's
// "build next" button (admin-newsletter.ts) and the autonomous kickoff tick
// (routes/newsletter-scheduler.ts) so the two NEVER drift on how an issue is born.
//
// Pipeline (each sub-step's status is recorded on the issue's build_steps ledger):
//   changelog → pick deduped educational topic → generate copy (content-ai-email)
//   → generate imagery → render HTML+plaintext → persist a complete
//   newsletter_issues row (status='ready_for_qa').
//
// Guarantees:
//   • IDEMPOTENT — one issue per cadence period (period_key + partial UNIQUE
//     index); a re-trigger within the same period returns the existing issue.
//   • RESUMABLE — a sub-step failure leaves a draft shell whose build_steps say
//     what's done; the next tick reuses completed copy/imagery instead of
//     re-spending on AI.
//   • GRACEFUL — no fresh "what's new" ⇒ the issue leans on evergreen educational
//     content (never skips, never invents news).
//   • METERED — all AI calls route through the ai-limiter (via getAnthropicClient
//     in newsletter-copy / the image model), counting toward AI spend/budget.
//   • CONFIGURABLE — cadence / audiences / max-images / max-sections live in the
//     newsletter assembler settings singleton (lib/newsletter-settings.ts).

import { supabaseAdmin } from "./supabase.ts";
import { getSetting } from "./system-settings.ts";
import {
  escapeHtml,
  isEditable,
  isNewsletterStatus,
  type NewsletterSection,
  type NewsletterStatus,
  renderNewsletterHtml,
  renderNewsletterText,
  runIssueQa,
} from "./newsletter-issue.ts";
import { type SubjectVariant } from "./newsletter-ab.ts";
import {
  NEWSLETTER_TOPICS,
  type NewsletterTopic,
  selectWeightedKey,
  type SubjectStyle,
  SUBJECT_STYLES,
  subjectStyleById,
  topicByPillarAngle,
  topicById,
} from "./newsletter-tuning.ts";
import { loadNewsletterSettings } from "./newsletter-settings.ts";
import {
  type ChangelogEntry,
  changelogToLines,
  fetchChangelogPool,
  loadFeaturedContentIds,
  loadRecentProductFocus,
  pickProductFocus,
  selectChangelogEntries,
} from "./newsletter-changelog.ts";
import { generateNewsletterCopy } from "./newsletter-copy.ts";
import {
  resolveImageFromUrl,
  resolveIssueImage,
  type ResolvedIssueImage,
} from "./newsletter-imagery.ts";
import type { ContentProduct } from "./content-history.ts";
import { markEmailTopicUsed, selectEmailTopic } from "./newsletter-topic-bank-job.ts";

// The full column projection both callers select for an issue. Kept here (with the
// assembler that writes the row) so the console + tick select the identical shape.
export const NEWSLETTER_ISSUE_COLS =
  "id, title, subject, preheader, sections, status, audience, segment_id, " +
  "scheduled_for, qa_results, recipients_total, sent_count, skipped_count, " +
  "failed_count, block_reason, created_by, approved_by, approved_at, " +
  "send_started_at, sent_at, created_at, updated_at, " +
  "pillar, angle, subject_style, send_hour, " +
  "subject_variants, ab_metric, ab_test_fraction, ab_measurement_hours, " +
  "ab_phase, ab_test_started_at, ab_winner_variant, ab_winner_source, " +
  "period_key, build_steps, featured_content_ids, product_focus, " +
  "hero_image_url, body_text, body_html";

// At most this many "what's new" entries are featured per issue.
const MAX_WHATS_NEW = 4;

// ── Build-step ledger (resumability) ─────────────────────────────────────────

export const ASSEMBLY_STEPS = ["changelog", "copy", "imagery", "render", "finalize"] as const;
export type AssemblyStep = (typeof ASSEMBLY_STEPS)[number];
export type StepStatus = "pending" | "done" | "failed" | "skipped";
export interface StepRecord {
  status: StepStatus;
  at?: string;
  detail?: string;
}
export type BuildSteps = Record<string, StepRecord>;

export function initBuildSteps(): BuildSteps {
  const s: BuildSteps = {};
  for (const step of ASSEMBLY_STEPS) s[step] = { status: "pending" };
  return s;
}

function markStep(
  steps: BuildSteps,
  step: AssemblyStep,
  status: StepStatus,
  nowMs: number,
  detail?: string,
): void {
  steps[step] = { status, at: new Date(nowMs).toISOString(), ...(detail ? { detail } : {}) };
}

function stepDone(steps: BuildSteps, step: AssemblyStep): boolean {
  return steps[step]?.status === "done";
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** Deterministic cadence-period key — the same for every instant within a period. */
export function computePeriodKey(nowMs: number, cadenceDays: number): string {
  const periodMs = Math.max(1, Math.floor(cadenceDays)) * 86_400_000;
  return `p${Math.floor(nowMs / periodMs)}`;
}

/** The next future UTC datetime whose hour == `hour`. Pure given `nowMs`. */
export function nextSendAt(hour: number, nowMs: number): string {
  const d = new Date(nowMs);
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(hour);
  if (d.getTime() <= nowMs) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

/** The deterministic "What's new" block from the featured changelog entries. Pure. */
export function buildWhatsNewSection(entries: ChangelogEntry[]): NewsletterSection | null {
  if (entries.length === 0) return null;
  const items = entries
    .map((e) => {
      const summary = e.summary ? `: ${escapeHtml(e.summary)}` : "";
      return `<li><strong>${escapeHtml(e.title)}</strong>${summary}</li>`;
    })
    .join("");
  return { heading: "What's new at GradeThread", body: `<ul>${items}</ul>` };
}

function uniformWeights(ids: string[]): Record<string, number> {
  return Object.fromEntries(ids.map((id) => [id, 1]));
}

// US-928: the self-tuning bias the assembler reads (topic + subject-style + send
// hour). The tuning cron populates these stores from engagement; this consumes them.
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

// ── Result types (stable for the callers) ────────────────────────────────────

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
  /** The full row (NEWSLETTER_ISSUE_COLS projection) so the console can return it. */
  row: unknown;
}

export interface AssembleResult {
  /** The assembled issue, or null when assembly could not produce a usable row. */
  issue: AssembledIssue | null;
  /** Audit/log detail: which catalog dimensions were chosen. */
  chosen: { topicId: string; styleId: string; sendHour: number };
  /** True when this period's issue already existed (idempotent no-op). */
  idempotent?: boolean;
  /** True when one or more sub-steps failed and the build is resumable. */
  resumable?: boolean;
  error?: string;
}

// The working-row shape the assembler reads/writes.
interface IssueRow {
  id: string;
  title: string;
  subject: string;
  preheader: string | null;
  sections: unknown;
  status: string;
  pillar: string | null;
  angle: string | null;
  subject_style: string | null;
  send_hour: number | null;
  product_focus: string | null;
  audience: string | null;
  hero_image_url: string | null;
  featured_content_ids: unknown;
  build_steps: unknown;
  topic_bank_id: string | null;
}

const ISSUE_WORK_COLS =
  "id, title, subject, preheader, sections, status, pillar, angle, subject_style, " +
  "send_hour, product_focus, audience, hero_image_url, featured_content_ids, build_steps, " +
  "topic_bank_id";

async function loadIssueByPeriodKey(periodKey: string): Promise<IssueRow | null> {
  const { data } = await supabaseAdmin
    .from("newsletter_issues")
    .select(ISSUE_WORK_COLS)
    .eq("period_key", periodKey)
    .maybeSingle();
  return (data ?? null) as unknown as IssueRow | null;
}

function asSections(v: unknown): NewsletterSection[] {
  return Array.isArray(v) ? (v as NewsletterSection[]) : [];
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
function asBuildSteps(v: unknown): BuildSteps {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as BuildSteps) : initBuildSteps();
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function idempotentResult(row: IssueRow): Promise<AssembleResult> {
  const { data: full } = await supabaseAdmin
    .from("newsletter_issues")
    .select(NEWSLETTER_ISSUE_COLS)
    .eq("id", row.id)
    .maybeSingle();
  return {
    issue: rowToAssembled(row, row.subject ?? "", row.status, full ?? row),
    chosen: {
      topicId: topicByPillarAngle(row.pillar, row.angle)?.id ?? "",
      styleId: row.subject_style ?? "",
      sendHour: typeof row.send_hour === "number" ? row.send_hour : 14,
    },
    idempotent: true,
  };
}

function rowToAssembled(row: { id: string; title?: string }, subject: string, status: string, full?: unknown): AssembledIssue {
  const r = row as Record<string, unknown>;
  return {
    id: row.id,
    title: typeof row.title === "string" ? row.title : "",
    subject,
    status,
    scheduled_for: (r.scheduled_for as string | null) ?? null,
    pillar: (r.pillar as string | null) ?? null,
    angle: (r.angle as string | null) ?? null,
    subject_style: (r.subject_style as string | null) ?? null,
    send_hour: typeof r.send_hour === "number" ? (r.send_hour as number) : null,
    row: full ?? row,
  };
}

// ── Dimension selection ──────────────────────────────────────────────────────

interface Dimensions {
  topic: NewsletterTopic;
  style: SubjectStyle;
  sendHour: number;
  productFocus: ContentProduct;
  audience: string;
  /** US-917: the evergreen bank row this angle came from (null on static fallback). */
  bankId: string | null;
  /** US-917: one-line lesson summary + real-capability hints fed to the copy prompt. */
  topicSummary: string;
  topicKeyPoints: string[];
}

async function chooseDimensions(
  periodKey: string,
  recentFocuses: string[],
  audiences: string[],
  dedupWindowDays: number,
  nowMs: number,
): Promise<Dimensions> {
  const bias = await loadAssemblerBias();
  const seed = `nl-${periodKey}`;

  const style =
    subjectStyleById(selectWeightedKey(bias.styleWeights, `${seed}:style`) ?? "") ??
    subjectStyleById(selectWeightedKey(uniformWeights(SUBJECT_STYLES.map((s) => s.id)), `${seed}:style`)!)!;
  const sendHour = bias.bestHour ?? 14;
  const productFocus = pickProductFocus(recentFocuses);
  const periodNum = Number.parseInt(periodKey.slice(1), 10);
  const idx = Number.isFinite(periodNum) ? Math.abs(periodNum) % audiences.length : 0;
  const audience = audiences[idx] ?? "all_confirmed";

  // US-917: pick a deduped evergreen educational angle from the topic bank. Falls
  // back to the static tuning catalog when the bank is empty (e.g. unseeded).
  const bankSel = await selectEmailTopic({
    nowMs,
    productFocus,
    windowDays: dedupWindowDays,
    biasTopicWeights: bias.topicWeights,
    seed,
  });
  let topic: NewsletterTopic;
  let bankId: string | null = null;
  let topicSummary = "";
  let topicKeyPoints: string[] = [];
  if (bankSel) {
    topic = bankSel.topic;
    bankId = bankSel.bankId;
    topicSummary = bankSel.summary;
    topicKeyPoints = bankSel.keyPoints;
  } else {
    topic =
      topicById(selectWeightedKey(bias.topicWeights, seed) ?? "") ??
      topicById(selectWeightedKey(uniformWeights(NEWSLETTER_TOPICS.map((t) => t.id)), seed)!)!;
  }

  return { topic, style, sendHour, productFocus, audience, bankId, topicSummary, topicKeyPoints };
}

function dimensionsFromRow(row: IssueRow, fallback: Dimensions): Dimensions {
  const topic = topicByPillarAngle(row.pillar, row.angle) ??
    (row.pillar && row.angle
      ? { id: `${row.pillar}:${row.angle}`, pillar: row.pillar, angle: row.angle, label: row.title }
      : fallback.topic);
  const style = subjectStyleById(row.subject_style ?? "") ?? fallback.style;
  const sendHour = typeof row.send_hour === "number" ? row.send_hour : fallback.sendHour;
  const productFocus = (["gradethread", "flipdesk", "both"] as const).includes(
    row.product_focus as ContentProduct,
  )
    ? (row.product_focus as ContentProduct)
    : fallback.productFocus;
  const audience = row.audience?.trim() || fallback.audience;
  // Resume reuses persisted copy, so topic summary/hints aren't needed again.
  return {
    topic,
    style,
    sendHour,
    productFocus,
    audience,
    bankId: row.topic_bank_id ?? fallback.bankId,
    topicSummary: "",
    topicKeyPoints: [],
  };
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Build the next issue. Idempotent per cadence period (returns the existing issue
 * if one already exists), resumable on sub-step failure. `nowMs` is injected so
 * the period key + scheduled instant are deterministic in tests.
 */
export async function assembleNextIssue(
  createdBy: string | null,
  nowMs: number,
): Promise<AssembleResult> {
  const settings = await loadNewsletterSettings();
  const periodKey = computePeriodKey(nowMs, settings.cadencePeriodDays);

  // ── Idempotency / resume ──
  let row = await loadIssueByPeriodKey(periodKey);
  if (row) {
    const status = (isNewsletterStatus(row.status) ? row.status : "draft") as NewsletterStatus;
    const steps = asBuildSteps(row.build_steps);
    // Already fully built this period, or already advanced past editing → no-op.
    if (stepDone(steps, "finalize") || !isEditable(status)) {
      return await idempotentResult(row);
    }
  } else if (!settings.enabled) {
    // Disabled + nothing to resume → scaffold nothing (existing issues still flow).
    return { issue: null, chosen: { topicId: "", styleId: "", sendHour: 14 }, error: "assembler disabled" };
  }

  // ── Choose (or reconstruct) the issue dimensions ──
  const recentFocuses = await loadRecentProductFocus();
  const freshDims = await chooseDimensions(
    periodKey,
    recentFocuses,
    settings.audiences,
    settings.topicDedupWindowDays,
    nowMs,
  );
  const dims = row ? dimensionsFromRow(row, freshDims) : freshDims;

  // ── Insert the shell row if this is a fresh period ──
  if (!row) {
    const steps = initBuildSteps();
    const { data, error } = await supabaseAdmin
      .from("newsletter_issues")
      .insert({
        title: dims.topic.label,
        subject: "",
        sections: [],
        status: "draft",
        period_key: periodKey,
        build_steps: steps,
        product_focus: dims.productFocus,
        audience: dims.audience,
        pillar: dims.topic.pillar,
        angle: dims.topic.angle,
        subject_style: dims.style.id,
        send_hour: dims.sendHour,
        topic_bank_id: dims.bankId,
        created_by: createdBy,
      })
      .select(ISSUE_WORK_COLS)
      .maybeSingle();
    if (error || !data) {
      // A concurrent run may have won the period_key race — try to resume theirs.
      const raced = await loadIssueByPeriodKey(periodKey);
      if (raced) {
        row = raced;
      } else {
        return {
          issue: null,
          chosen: { topicId: dims.topic.id, styleId: dims.style.id, sendHour: dims.sendHour },
          error: error?.message ?? "shell insert returned no row",
        };
      }
    } else {
      row = data as unknown as IssueRow;
      // US-917: advance the evergreen dedup window — this period claimed the angle.
      if (dims.bankId) await markEmailTopicUsed(dims.bankId, nowMs);
    }
  }

  const issueId = row.id;
  const steps = asBuildSteps(row.build_steps);
  const chosen = { topicId: dims.topic.id, styleId: dims.style.id, sendHour: dims.sendHour };

  // ── Step 1: changelog ("what's new") ──
  let entries: ChangelogEntry[] = [];
  let featuredIds: string[] = [];
  const reuseCopy = stepDone(steps, "copy") && !!row.subject && asSections(row.sections).length > 0;
  if (reuseCopy) {
    featuredIds = asStringArray(row.featured_content_ids);
  } else {
    try {
      const [pool, alreadyFeatured] = await Promise.all([
        fetchChangelogPool(settings.changelogLookbackDays, nowMs),
        loadFeaturedContentIds(),
      ]);
      entries = selectChangelogEntries(pool, alreadyFeatured, dims.productFocus, MAX_WHATS_NEW);
      featuredIds = entries.map((e) => e.id);
      markStep(steps, "changelog", "done", nowMs, `${entries.length} featured`);
    } catch (e) {
      // Non-fatal: no "what's new" ⇒ evergreen lean (AC3).
      markStep(steps, "changelog", "failed", nowMs, errMsg(e));
      entries = [];
      featuredIds = [];
    }
  }

  // ── Step 2: copy (content-ai-email) ──
  let subject: string;
  let preheader: string;
  let finalSections: NewsletterSection[];
  if (reuseCopy) {
    subject = row.subject;
    preheader = row.preheader ?? "";
    finalSections = asSections(row.sections);
  } else {
    const { brandVoice, valueProps } = await loadCopyKnowledge();
    const copy = await generateNewsletterCopy({
      topic: dims.topic,
      style: dims.style,
      changelogLines: changelogToLines(entries),
      productFocus: dims.productFocus,
      maxSections: settings.maxSections,
      brandVoice,
      valueProps,
      topicSummary: dims.topicSummary,
      topicKeyPoints: dims.topicKeyPoints,
    });
    subject = copy.subject;
    preheader = copy.preheader;
    const whatsNew = buildWhatsNewSection(entries);
    finalSections = whatsNew ? [whatsNew, ...copy.sections] : copy.sections;
    markStep(steps, "copy", "done", nowMs, copy.degraded ? "evergreen-fallback" : "ai");

    // Persist copy + featured ids so a later sub-step failure resumes without
    // re-spending on the model.
    await patchIssue(issueId, {
      subject,
      preheader,
      sections: finalSections,
      featured_content_ids: featuredIds,
      product_focus: dims.productFocus,
      audience: dims.audience,
      build_steps: steps,
    });
  }

  // ── Step 3: imagery (best-effort, never throws; reuses if already built) ──
  // An AI photo (gpt-image-1) when imagery is enabled, else/on failure a
  // deterministic branded banner card — so an issue is never blocked on imagery.
  let image: ResolvedIssueImage | null = null;
  if (row.hero_image_url) {
    image = resolveImageFromUrl(row.hero_image_url, dims.topic.label);
    markStep(steps, "imagery", "done", nowMs, "reused");
  } else {
    const resolved = await resolveIssueImage({
      issueId,
      title: subject || dims.topic.label,
      topicLabel: dims.topic.label,
      product: dims.productFocus,
      maxImages: settings.maxImages,
    });
    image = resolved.image;
    markStep(steps, "imagery", "done", nowMs, resolved.detail);
    await patchIssue(issueId, { hero_image_url: image.url, build_steps: steps });
  }
  const heroUrl: string | null = image?.url ?? null;

  // ── Step 4: render HTML + plaintext ──
  let bodyHtml: string;
  let bodyText: string;
  try {
    const heroSection: NewsletterSection | null = image
      ? { body: image.html }
      : null;
    const renderSections = heroSection ? [heroSection, ...finalSections] : finalSections;
    bodyHtml = renderNewsletterHtml({ subject, preheader, sections: renderSections });
    bodyText = renderNewsletterText({ subject, sections: finalSections });
    markStep(steps, "render", "done", nowMs);
  } catch (e) {
    markStep(steps, "render", "failed", nowMs, errMsg(e));
    await patchIssue(issueId, { build_steps: steps });
    return {
      issue: null,
      chosen,
      resumable: true,
      error: `render failed: ${errMsg(e)}`,
    };
  }

  // ── Step 5: finalize → ready_for_qa ──
  const qa = runIssueQa({ subject, sections: finalSections });
  const scheduledFor = nextSendAt(dims.sendHour, nowMs);
  const subjectVariants: SubjectVariant[] = [
    { id: "a", subject, label: "Variant A" },
    { id: "b", subject: `${dims.topic.label}: what most resellers miss`, label: "Variant B" },
  ];
  markStep(steps, "finalize", "done", nowMs);

  const { data: finalData, error: finalErr } = await supabaseAdmin
    .from("newsletter_issues")
    .update({
      title: dims.topic.label,
      subject,
      preheader,
      sections: finalSections,
      subject_variants: subjectVariants,
      body_html: bodyHtml,
      body_text: bodyText,
      hero_image_url: heroUrl,
      featured_content_ids: featuredIds,
      product_focus: dims.productFocus,
      audience: dims.audience,
      status: "ready_for_qa",
      qa_results: qa,
      pillar: dims.topic.pillar,
      angle: dims.topic.angle,
      subject_style: dims.style.id,
      send_hour: dims.sendHour,
      topic_bank_id: dims.bankId,
      scheduled_for: scheduledFor,
      build_steps: steps,
    })
    .eq("id", issueId)
    .select(NEWSLETTER_ISSUE_COLS)
    .maybeSingle();

  if (finalErr || !finalData) {
    // Persist the failed-finalize marker so the next tick retries just this step.
    markStep(steps, "finalize", "failed", nowMs, finalErr?.message ?? "no row");
    await patchIssue(issueId, { build_steps: steps });
    return {
      issue: null,
      chosen,
      resumable: true,
      error: finalErr?.message ?? "finalize returned no row",
    };
  }

  return {
    issue: {
      id: issueId,
      title: dims.topic.label,
      subject,
      status: "ready_for_qa",
      scheduled_for: scheduledFor,
      pillar: dims.topic.pillar,
      angle: dims.topic.angle,
      subject_style: dims.style.id,
      send_hour: dims.sendHour,
      row: finalData,
    },
    chosen,
  };
}

// Single-field patch helper (best-effort). Used for the resumability checkpoints.
async function patchIssue(id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabaseAdmin.from("newsletter_issues").update(patch).eq("id", id);
  if (error) console.error(`[newsletter-assembler] patch failed (${id}): ${error.message}`);
}

// US-917: knowledge docs for the copywriter — brand voice + the approved
// value-props the copy may cite (grounds AC6: cite real capabilities, no
// invented claims). Best-effort: empty strings when a doc is absent.
async function loadCopyKnowledge(): Promise<{ brandVoice: string; valueProps: string }> {
  const { data } = await supabaseAdmin
    .from("content_knowledge")
    .select("key, body_md")
    .in("key", ["brand.voice", "email.value_props"]);
  const map = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ key?: string; body_md?: string }>) {
    map.set(String(row.key ?? ""), String(row.body_md ?? ""));
  }
  return { brandVoice: map.get("brand.voice") ?? "", valueProps: map.get("email.value_props") ?? "" };
}
