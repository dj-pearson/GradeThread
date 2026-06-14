// US-583: Anthropic token-usage capture for per-grade AI-cost reporting.
//
// The grading pipeline makes one Anthropic call per image plus one composite
// call. Each call returns `usage` (input/output/cache tokens); we turn that into
// a USD cost from the model price table below and append a row to
// `ai_usage_events` (migration 00163). The admin dashboard then reads cost per
// grade / per day / gross-margin from that ledger — no heuristics.
//
// Costs are LIST-PRICE ESTIMATES. The per-million-token rates match Anthropic's
// published pricing for the models on the grading allowlist (see ai-config.ts).
// An operator can override a rate via AI_PRICE_<dimension>_<MODEL> env vars if
// negotiated/changed pricing differs, so a price change never requires a deploy.

import type Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin } from "./supabase.ts";

// Per-million-token USD list prices. Input/output plus the standard cache
// multipliers Anthropic applies: 5-minute cache WRITE = 1.25× input, cache
// READ = 0.1× input. Keyed by model id (ai-config.ts GRADING_MODEL_ALLOWLIST).
interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5-20251001": { inputPerMTok: 1, outputPerMTok: 5 },
  // Alias without the date suffix, in case DEFAULT_AI_MODEL is set to the bare id.
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

// Anthropic's standard cache multipliers (relative to the input rate).
const CACHE_WRITE_MULTIPLIER = 1.25; // 5-minute ephemeral cache write
const CACHE_READ_MULTIPLIER = 0.1; // cache read

export interface AiTokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

// Normalize an Anthropic SDK `usage` object (+ the model that produced it) into
// our flat shape. Cache fields are nullable on the SDK type — default to 0.
export function toAiTokenUsage(
  model: string,
  usage: Anthropic.Usage,
): AiTokenUsage {
  return {
    model,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  };
}

// Look up a per-million rate, honoring an optional operator override env var so
// pricing changes don't need a code deploy. Falls back to the table, then 0
// (unknown model → tokens still recorded, cost 0, so it's visible not hidden).
function rate(
  envName: string,
  tableValue: number | undefined,
): number {
  const raw = Deno.env.get(envName);
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return tableValue ?? 0;
}

// USD cost of a single Anthropic call. Cache-write tokens bill at 1.25× input,
// cache-read at 0.1× input, ordinary input at 1× input, output at the output rate.
export function computeCostUsd(usage: AiTokenUsage): number {
  const price = MODEL_PRICES[usage.model];
  const modelKey = usage.model.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const inputRate = rate(`AI_PRICE_INPUT_${modelKey}`, price?.inputPerMTok);
  const outputRate = rate(`AI_PRICE_OUTPUT_${modelKey}`, price?.outputPerMTok);

  const cost =
    (usage.inputTokens * inputRate +
      usage.outputTokens * outputRate +
      usage.cacheCreationTokens * inputRate * CACHE_WRITE_MULTIPLIER +
      usage.cacheReadTokens * inputRate * CACHE_READ_MULTIPLIER) /
    1_000_000;

  // Round to 6 decimals to match the numeric(12,6) column.
  return Math.round(cost * 1e6) / 1e6;
}

// US-894: fast, stable, non-crypto fingerprint of a prompt body so the spend
// view can spot a repeated/runaway prompt. FNV-1a (32-bit) — NOT a security
// hash; collisions are acceptable for "is this the same prompt again".
export function hashPrompt(input: unknown): string {
  const s = typeof input === "string" ? input : JSON.stringify(input ?? "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export interface RecordAiUsageInput {
  userId: string | null;
  submissionId: string | null;
  // Feature that made the call. Defaults to 'grading' — the only feature that
  // logged before US-894 — so existing callers stay correct.
  feature?: string;
  // One entry per phase; `phase` labels the grading stage that made the call.
  usages: Array<{ phase: string; usage: AiTokenUsage }>;
}

// Append one ai_usage_events row per Anthropic call. Best-effort and never
// throws: a cost-tracking write must never fail a paid grade. The table is not
// in the generated Database types, so the client is cast locally.
export async function recordAiUsage(input: RecordAiUsageInput): Promise<void> {
  const feature = input.feature ?? "grading";
  const rows = input.usages
    .filter((u) => u.usage)
    .map(({ phase, usage }) => ({
      user_id: input.userId,
      submission_id: input.submissionId,
      phase,
      feature,
      model: usage.model,
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_creation_tokens: usage.cacheCreationTokens,
      cache_read_tokens: usage.cacheReadTokens,
      cost_usd: computeCostUsd(usage),
    }));

  if (rows.length === 0) return;

  try {
    const { error } = await supabaseAdmin
      .from("ai_usage_events")
      .insert(rows as never);
    if (error) {
      console.warn(`[ai-usage] failed to record usage: ${error.message}`);
    }
  } catch (e) {
    console.warn(
      `[ai-usage] failed to record usage: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export interface RecordAiCallInput {
  feature: string;
  userId: string | null;
  submissionId?: string | null;
  usage: AiTokenUsage;
  latencyMs: number | null;
  promptHash: string | null;
}

// US-894: record ONE Anthropic call to the ledger, attributed to a feature.
// Called by the limiter capture in ai-config.ts for any feature-tagged call.
// Best-effort + never throws — usage tracking must never break a live AI flow.
export async function recordAiCall(input: RecordAiCallInput): Promise<void> {
  const row = {
    user_id: input.userId,
    submission_id: input.submissionId ?? null,
    // `phase` predates the `feature` column; keep it populated for back-compat.
    phase: input.feature,
    feature: input.feature,
    model: input.usage.model,
    input_tokens: input.usage.inputTokens,
    output_tokens: input.usage.outputTokens,
    cache_creation_tokens: input.usage.cacheCreationTokens,
    cache_read_tokens: input.usage.cacheReadTokens,
    cost_usd: computeCostUsd(input.usage),
    prompt_hash: input.promptHash,
    latency_ms: input.latencyMs,
  };

  try {
    const { error } = await supabaseAdmin
      .from("ai_usage_events")
      .insert(row as never);
    if (error) {
      console.warn(`[ai-usage] failed to record call: ${error.message}`);
    }
  } catch (e) {
    console.warn(
      `[ai-usage] failed to record call: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
