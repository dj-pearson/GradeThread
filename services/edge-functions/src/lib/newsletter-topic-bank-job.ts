// US-917: Evergreen topic-bank DB side (impure) — selection, mark-used, refill.
//
// The PURE selection / dedup / refill-parsing logic lives in
// newsletter-topic-bank.ts; this module is the supabase + AI glue:
//   • selectEmailTopic  — load the bank, gather what's been covered recently
//                         (bank last_used_at + recently-sent issues +
//                         content_history_index), and pick a deduped angle.
//   • markEmailTopicUsed — stamp last_used_at + bump use_count when an issue
//                         claims an angle (advances the dedup window).
//   • refillEmailTopicBank — when the active bank drops below the min, generate
//                         fresh evergreen angles with the lightweight model
//                         (Haiku), dedup against existing rows, and insert.

import { supabaseAdmin } from "./supabase.ts";
import { getSetting } from "./system-settings.ts";
import {
  type BankSelection,
  type CoverageContext,
  type EmailTopicBankRow,
  buildRefillSystemPrompt,
  buildRefillUserPrompt,
  EMAIL_TOPIC_REFILL_PROMPT_VERSION,
  needsRefill,
  normalizeBankRow,
  parseRefillCandidates,
  selectFromBank,
  topicKey,
} from "./newsletter-topic-bank.ts";
import type { ContentProduct } from "./content-history.ts";

const BANK_COLS =
  "id, pillar, angle, label, summary, key_points, product_focus, status, source, last_used_at, use_count";

// Issue statuses that have already "claimed" their topic for the dedup window.
const CONSUMED_ISSUE_STATUSES = [
  "ready_for_qa",
  "awaiting_review",
  "approved",
  "scheduled",
  "sending",
  "sent",
];

function focusFilter(productFocus: ContentProduct): string[] {
  return productFocus === "both" ? ["gradethread", "flipdesk", "both"] : [productFocus, "both"];
}

async function loadActiveBankRows(productFocus: ContentProduct): Promise<EmailTopicBankRow[]> {
  const { data, error } = await supabaseAdmin
    .from("email_topic_bank")
    .select(BANK_COLS)
    .eq("status", "active")
    .in("product_focus", focusFilter(productFocus));
  if (error) {
    console.error(`[topic-bank] load active rows failed: ${error.message}`);
    return [];
  }
  return ((data ?? []) as unknown as unknown[])
    .map(normalizeBankRow)
    .filter((r): r is EmailTopicBankRow => r !== null);
}

/**
 * Pick a deduped evergreen educational angle for the next issue. Returns null only
 * when the bank is empty (the assembler then falls back to its static catalog).
 */
export async function selectEmailTopic(input: {
  nowMs: number;
  productFocus: ContentProduct;
  windowDays: number;
  biasTopicWeights: Record<string, number>;
  seed: string;
}): Promise<BankSelection | null> {
  const rows = await loadActiveBankRows(input.productFocus);
  if (rows.length === 0) return null;

  const windowMs = Math.max(1, Math.floor(input.windowDays)) * 86_400_000;
  const cutoffIso = new Date(input.nowMs - windowMs).toISOString();

  const coveredTopicKeys = new Set<string>();
  const coveredLabels = new Set<string>();
  const bankById = new Map(rows.map((r) => [r.id, r]));

  // Recently-sent / in-flight issues — exclude their (pillar, angle) and exact bank row.
  const { data: issues } = await supabaseAdmin
    .from("newsletter_issues")
    .select("pillar, angle, topic_bank_id, updated_at")
    .in("status", CONSUMED_ISSUE_STATUSES)
    .gte("updated_at", cutoffIso);
  for (const row of (issues ?? []) as Array<Record<string, unknown>>) {
    const pillar = typeof row.pillar === "string" ? row.pillar : "";
    const angle = typeof row.angle === "string" ? row.angle : "";
    if (pillar && angle) coveredTopicKeys.add(topicKey(pillar, angle));
    const bankId = typeof row.topic_bank_id === "string" ? row.topic_bank_id : "";
    const claimed = bankById.get(bankId);
    if (claimed) coveredTopicKeys.add(topicKey(claimed.pillar, claimed.angle));
  }

  // content_history_index email rows — exclude any angle whose label was the topic.
  const { data: history } = await supabaseAdmin
    .from("content_history_index")
    .select("title")
    .eq("surface", "email")
    .gte("published_at", cutoffIso);
  for (const row of (history ?? []) as Array<Record<string, unknown>>) {
    const title = typeof row.title === "string" ? row.title.trim().toLowerCase() : "";
    if (title) coveredLabels.add(title);
  }

  const ctx: CoverageContext = { cutoffIso, coveredTopicKeys, coveredLabels };
  return selectFromBank(rows, ctx, input.biasTopicWeights, input.seed);
}

/** Advance the dedup window for an angle: stamp last_used_at + bump use_count. */
export async function markEmailTopicUsed(bankId: string, nowMs: number): Promise<void> {
  if (!bankId) return;
  const { data } = await supabaseAdmin
    .from("email_topic_bank")
    .select("use_count")
    .eq("id", bankId)
    .maybeSingle();
  const current = Number((data as { use_count?: number } | null)?.use_count ?? 0);
  const { error } = await supabaseAdmin
    .from("email_topic_bank")
    .update({ last_used_at: new Date(nowMs).toISOString(), use_count: current + 1 })
    .eq("id", bankId);
  if (error) console.error(`[topic-bank] mark used failed (${bankId}): ${error.message}`);
}

// ── Refill ───────────────────────────────────────────────────────────────────

export interface RefillResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  activeBefore: number;
  inserted: number;
  rejectedDuplicates: number;
  meta?: { model_used: string; prompt_version: string; prompt_tokens: number; completion_tokens: number };
}

async function countActiveBank(): Promise<number> {
  const { count } = await supabaseAdmin
    .from("email_topic_bank")
    .select("id", { count: "exact", head: true })
    .eq("status", "active");
  return count ?? 0;
}

async function loadExistingKeys(): Promise<Set<string>> {
  const { data } = await supabaseAdmin.from("email_topic_bank").select("pillar, angle");
  const keys = new Set<string>();
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const pillar = typeof row.pillar === "string" ? row.pillar : "";
    const angle = typeof row.angle === "string" ? row.angle : "";
    if (pillar && angle) keys.add(topicKey(pillar, angle));
  }
  return keys;
}

async function loadRefillKnowledge(): Promise<{ brandVoice: string; valueProps: string }> {
  const { data } = await supabaseAdmin
    .from("content_knowledge")
    .select("key, body_md")
    .in("key", ["brand.voice", "email.value_props"]);
  const map = new Map<string, string>();
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    map.set(String(row.key ?? ""), String(row.body_md ?? ""));
  }
  return { brandVoice: map.get("brand.voice") ?? "", valueProps: map.get("email.value_props") ?? "" };
}

/**
 * Top the bank up toward the target when it has dropped below the minimum. Uses
 * the lightweight model (Haiku) constrained to evergreen, email-appropriate,
 * grounded angles. No-op (skipped) when disabled or already above the minimum.
 */
export async function refillEmailTopicBank(): Promise<RefillResult> {
  const [enabled, min, target] = await Promise.all([
    getSetting<boolean>("newsletter_topic_refill_enabled", true),
    getSetting<number>("newsletter_topic_bank_min", 12),
    getSetting<number>("newsletter_topic_bank_target", 24),
  ]);

  const activeBefore = await countActiveBank();
  if (!enabled) {
    return { ok: true, skipped: true, reason: "refill disabled", activeBefore, inserted: 0, rejectedDuplicates: 0 };
  }
  const minN = Math.max(0, Math.floor(Number(min ?? 12)));
  const targetN = Math.max(minN, Math.floor(Number(target ?? 24)));
  if (!needsRefill(activeBefore, minN)) {
    return { ok: true, skipped: true, reason: "above minimum", activeBefore, inserted: 0, rejectedDuplicates: 0 };
  }

  const want = Math.max(1, targetN - activeBefore);
  const existing = await loadExistingKeys();
  const knowledge = await loadRefillKnowledge();

  // Generate via the lightweight model — dynamic import so a future pure caller of
  // this module's siblings never eagerly pulls in ai-config → lib/supabase env.
  const { getAiTemperature, getAnthropicClient, getLightweightModel } = await import("./ai-config.ts");
  const { enterAiFeature } = await import("./ai-feature-context.ts");
  enterAiFeature("content"); // US-894 spend attribution (counts toward AI budget)

  const system = buildRefillSystemPrompt({
    brandVoice: knowledge.brandVoice,
    valueProps: knowledge.valueProps,
    existingKeys: [...existing],
  });
  const user = buildRefillUserPrompt(want + 4); // over-ask; dedup trims the surplus
  const temperature = getAiTemperature();
  const model = getLightweightModel();

  const response = await getAnthropicClient().messages.create({
    model,
    max_tokens: 2048,
    ...(temperature !== undefined ? { temperature } : {}),
    system,
    messages: [{ role: "user", content: user }],
  });
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("topic-refill response had no text block");
  }

  const candidates = parseRefillCandidates(textBlock.text);
  const fresh: typeof candidates = [];
  const seen = new Set(existing);
  for (const c of candidates) {
    const key = topicKey(c.pillar, c.angle);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(c);
    if (fresh.length >= want) break;
  }
  const rejectedDuplicates = candidates.length - fresh.length;

  let inserted = 0;
  if (fresh.length > 0) {
    const { error, count } = await supabaseAdmin
      .from("email_topic_bank")
      .upsert(
        fresh.map((c) => ({
          pillar: c.pillar,
          angle: c.angle,
          label: c.label,
          summary: c.summary,
          key_points: c.key_points,
          product_focus: "both",
          status: "active",
          source: "ai_refill",
        })),
        { onConflict: "pillar,angle", ignoreDuplicates: true, count: "exact" },
      );
    if (error) {
      console.error(`[topic-bank] refill insert failed: ${error.message}`);
      throw new Error(`refill insert failed: ${error.message}`);
    }
    inserted = count ?? fresh.length;
  }

  console.log(
    `[topic-bank] refill | active_before=${activeBefore} | target=${targetN} | ` +
      `generated=${candidates.length} | inserted=${inserted} | dupes_rejected=${rejectedDuplicates}`,
  );

  return {
    ok: true,
    activeBefore,
    inserted,
    rejectedDuplicates,
    meta: {
      model_used: model,
      prompt_version: EMAIL_TOPIC_REFILL_PROMPT_VERSION,
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
    },
  };
}
