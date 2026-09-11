// US-918: Autonomous newsletter copywriter ("content-ai-email").
//
// Claude writes a complete weekly newsletter ISSUE end-to-end — subject + 2–3
// subject variants, preheader, intro, the teach/tip/CTA sections, and a footer
// note — reusing the content-ai prompt architecture so no human writes the
// email. Mirrors content-ai-blog.ts: the system prompt assembles the curated
// email knowledge docs (email.voice / email.structure / email.value_props) +
// the distilled history context + the issue's grounding inputs (changelog,
// chosen educational topic, KB tip); the user prompt carries the per-issue JSON
// schema. Output is validated/normalized/sanitized/grounded by the PURE
// helpers in content-ai-prompts.ts, then persisted to newsletter_issues as a
// `draft` with model_used + token counts recorded.
//
// AI spend: getAnthropicClient() routes through the ai-limiter, and
// enterAiFeature("content") attributes the call (US-894), so every issue counts
// toward the AI budget.
//
// Dedup on send (AC5) is enforced at the DB layer: the migration installs a
// trigger that appends the chosen topic + the distilled summary to
// content_history_index when an issue transitions to `sent`, so future issues
// (built by ANY send path) don't repeat it.

import { effortParams, getAiTemperature, getAnthropicClient, getContentModel } from "./ai-config.ts";
import { extractTextBlock } from "./ai-response-text.ts";
import { enterAiFeature } from "./ai-feature-context.ts";
import { supabaseAdmin } from "./supabase.ts";
import { buildHistoryContext, type ContentProduct } from "./content-history.ts";
import {
  buildEmailIssueSystemPrompt,
  buildEmailIssueUserPrompt,
  contentSystemBlocks,
  EMAIL_ISSUE_PROMPT_VERSION,
  type EmailIssueOutput,
  type EmailIssueTopic,
  parseEmailIssue,
} from "./content-ai-prompts.ts";

// ── US-3149 AC2/AC5: the email prompt is SPLIT but NOT cached, on purpose ─────
//
// AC5 is explicit that a prefix under the per-model minimum must have its size
// recorded rather than ship a breakpoint that is silently ignored. Two
// measurements decide this one, and both say no:
//
// 1. CADENCE. An ephemeral entry lives 5 minutes and a read refreshes it.
//    Newsletter issues are WEEKLY. Two calls seven days apart can never share
//    an entry, so a breakpoint here would pay the 1.25x write premium on every
//    call and be read by none of them - the one case the story calls worse than
//    no breakpoint at all. Blog/social/research get the opposite answer because
//    the scheduler generates several in a burst.
// 2. SIZE, measured 2026-09-10 by building the prompt from the knowledge pack
//    seeded in migration 00289 (email.voice + email.structure +
//    email.value_props): stable 3,210 chars, volatile 504. Converted three ways
//    against the Sonnet 5 minimum of 1,024 tokens:
//      2.68 chars/tok (the ratio the blog prefix actually measured on
//                      2026-09-08: 6,788 chars -> 2,532 tok)  ~1,198 tok
//      3.2  chars/tok                                          ~1,003 tok
//      4.0  chars/tok                                            ~803 tok
//    It STRADDLES the bar, which is the same trap social hit against Haiku's
//    2,048 - a character estimate cannot settle it either way. The real count
//    was not taken because this host has no ANTHROPIC_API_KEY and the live
//    content_knowledge rows are admin-editable (the seed is a floor, not the
//    value). It would not change the decision: cadence already rules the
//    breakpoint out.
//
// Splitting the prompt anyway is not wasted. It fixes the layout (the grounding
// and output rules were being billed after the volatile block), it puts this
// file on the one idiom the other five content callers use, and flipping the
// flag below is the whole change if the newsletter ever generates in a burst.
// Before flipping it, COUNT the prefix - do not estimate it.
const EMAIL_PREFIX_CACHEABLE = false;

const DEFAULT_MAX_SECTIONS = 4;

export interface EmailKnowledge {
  emailVoice: string;
  emailStructure: string;
  valueProps: string;
}

// Curated email reference docs loaded into every issue prompt (seeded by the
// US-918 migration; admins can refine them in /admin/content/knowledge).
export async function loadEmailKnowledge(): Promise<EmailKnowledge> {
  const { data, error } = await supabaseAdmin
    .from("content_knowledge")
    .select("key, body_md")
    .in("key", ["email.voice", "email.structure", "email.value_props"]);
  if (error) {
    throw new Error(`Failed to load email knowledge docs: ${error.message}`);
  }
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    map.set(row.key as string, (row.body_md as string) ?? "");
  }
  return {
    emailVoice: map.get("email.voice") ?? "",
    emailStructure: map.get("email.structure") ?? "",
    valueProps: map.get("email.value_props") ?? "",
  };
}

export interface GenerateEmailIssueInput {
  topic: EmailIssueTopic;
  /** Compact "what's new" grounding lines (may be empty → lean evergreen). */
  changelogLines: string[];
  /** Optional knowledge-base tip to weave in. */
  kbTip?: string;
  productFocus: ContentProduct;
  /** Max teach/tip/CTA sections to request (default 4). */
  maxSections?: number;
  /** Override the configured default model. */
  model?: string;
}

export interface EmailIssueMeta {
  model_used: string;
  prompt_version: string;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
}

export interface GenerateEmailIssueResult {
  issue: EmailIssueOutput;
  meta: EmailIssueMeta;
}

/**
 * Generate one newsletter issue via the configured Claude model, grounded in the
 * provided inputs. Validates/normalizes/sanitizes the JSON and returns the typed
 * issue + token/latency meta. Throws on a model/parse failure (the caller decides
 * whether to retry or fall back).
 */
export async function generateEmailIssue(
  input: GenerateEmailIssueInput,
): Promise<GenerateEmailIssueResult> {
  enterAiFeature("content"); // US-894 spend attribution (counts toward AI budget)

  const maxSections = input.maxSections ?? DEFAULT_MAX_SECTIONS;
  const [knowledge, historyContext] = await Promise.all([
    loadEmailKnowledge(),
    buildHistoryContext({ surface: "email", productFocus: input.productFocus, maxTokens: 2500 }),
  ]);

  const systemPrompt = buildEmailIssueSystemPrompt({
    ...knowledge,
    historyContext,
    topic: input.topic,
    changelogLines: input.changelogLines,
    kbTip: input.kbTip,
    productFocus: input.productFocus,
  });
  const userPrompt = buildEmailIssueUserPrompt({
    topic: input.topic,
    changelogLines: input.changelogLines,
    kbTip: input.kbTip,
    productFocus: input.productFocus,
    maxSections,
  });

  const client = getAnthropicClient();
  const model = input.model ?? getContentModel("email");
  const temperature = getAiTemperature();
  const startTime = Date.now();

  const response = await client.messages.create({
    model,
    ...effortParams(model, "content_email", "medium"),
    // ⚠️ max_tokens caps THINKING + TEXT on sonnet-5, not text alone. This
    // number was sized on sonnet-4-6, where omitting `thinking` meant no
    // thinking at all — see lib/ai-response-text.ts for the outage that
    // caused. Size it for the worst-case output PLUS reasoning headroom.
    max_tokens: 8192,
    ...(temperature !== undefined ? { temperature } : {}),
    system: contentSystemBlocks(systemPrompt, EMAIL_PREFIX_CACHEABLE),
    messages: [{ role: "user", content: userPrompt }],
  });
  const latencyMs = Date.now() - startTime;

  const rawText = extractTextBlock(response, "content-ai-email");

  const issue = parseEmailIssue(rawText, {
    changelogLines: input.changelogLines,
    maxSections,
  });

  console.log(
    `[content-ai-email] generated | model=${model} | focus=${input.productFocus} | ` +
      `input_tokens=${response.usage.input_tokens} | output_tokens=${response.usage.output_tokens} | ` +
      `latency_ms=${latencyMs} | subject="${issue.subject}"`,
  );

  return {
    issue,
    meta: {
      model_used: model,
      prompt_version: EMAIL_ISSUE_PROMPT_VERSION,
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
      latency_ms: latencyMs,
    },
  };
}

// The newsletter_issues subject_variants column stores the A/B-engine shape
// ({ id, subject, label }); the first slot is always the main subject so the
// dispatch path's `issue.subject || issue.title` and the A/B finalize agree.
interface StoredSubjectVariant {
  id: string;
  subject: string;
  label: string;
}

function buildStoredVariants(issue: EmailIssueOutput): StoredSubjectVariant[] {
  const all = [issue.subject, ...issue.subjectVariants].slice(0, 4);
  return all.map((subject, i) => ({
    id: String.fromCharCode(97 + i), // a, b, c, d
    subject,
    label: `Variant ${String.fromCharCode(65 + i)}`,
  }));
}

export interface PersistEmailIssueInput {
  issue: EmailIssueOutput;
  meta: EmailIssueMeta;
  topic: EmailIssueTopic;
  productFocus: ContentProduct;
  /** Reuse an existing draft id (idempotent per issue id; safe to retry). */
  issueId?: string;
  createdBy?: string | null;
}

/**
 * Persist a generated issue to newsletter_issues as a `draft`, recording the
 * model and token counts. Idempotent per issue id: when `issueId` is supplied it
 * overwrites that draft's generated content (no duplicate row, status untouched
 * so an advanced issue isn't reverted); otherwise it inserts a fresh draft.
 * Returns the issue id.
 */
export async function persistEmailIssue(input: PersistEmailIssueInput): Promise<string> {
  const { issue, meta, topic } = input;
  const focus: ContentProduct = (["gradethread", "flipdesk", "both"] as const).includes(
    input.productFocus,
  )
    ? input.productFocus
    : "both";

  // The editable content fields the generator owns (status/created_by are set
  // only on first insert so a retry can't revert an advanced issue).
  const content = {
    title: topic.label,
    subject: issue.subject,
    preheader: issue.preheader || null,
    intro: issue.intro || null,
    footer_note: issue.footerNote || null,
    sections: issue.sections,
    subject_variants: buildStoredVariants(issue),
    product_focus: focus,
    pillar: topic.pillar,
    angle: topic.angle,
    model_used: meta.model_used,
    prompt_version: meta.prompt_version,
    prompt_tokens: meta.prompt_tokens,
    completion_tokens: meta.completion_tokens,
    generated_topic: topic.label,
    generated_summary: issue.summaryOneLine || null,
  };

  if (input.issueId) {
    const { error } = await supabaseAdmin
      .from("newsletter_issues")
      .update(content)
      .eq("id", input.issueId);
    if (error) throw new Error(`persistEmailIssue update failed: ${error.message}`);
    return input.issueId;
  }

  const { data, error } = await supabaseAdmin
    .from("newsletter_issues")
    .insert({ ...content, status: "draft", created_by: input.createdBy ?? null })
    .select("id")
    .maybeSingle();
  if (error || !data) {
    throw new Error(`persistEmailIssue insert failed: ${error?.message ?? "no row returned"}`);
  }
  return (data as { id: string }).id;
}

// US-2363: `generateAndPersistEmailIssue` was deleted here. It bundled
// `generateEmailIssue` + `persistEmailIssue`, both of which callers already use
// separately — and separately on purpose: the route between them decides whether
// a generated issue is worth persisting at all. A one-shot that always writes
// removes that decision point, which is the opposite of a convenience.
