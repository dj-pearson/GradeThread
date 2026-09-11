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
//
// US-3342: every rate below carries the DATE it was read off the published
// table, as a field rather than as prose. The rate that went wrong went wrong as
// a sentence — an introductory price said to run through the end of last August,
// written in a comment that nothing checked and nobody re-read, and still
// sitting here eleven days after the date it named. Anything time-bound now goes
// in `provisionalUntil`, and tests/ai-price-provenance_test.ts fails the day that
// date passes. A corollary the same test enforces: prose in this file may not
// name a calendar date the table does not also hold as a value.

import { supabaseAdmin } from "./supabase.ts";
import { type AiUsage, normalizeUsage } from "./ai-provider.ts";
import { MODEL_IDS } from "./ai-model-registry.ts";

// Per-million-token USD list prices. Input/output plus the standard cache
// multipliers Anthropic applies: 5-minute cache WRITE = 1.25× input, cache
// READ = 0.1× input. Keyed by model id (ai-config.ts GRADING_MODEL_ALLOWLIST).
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  /**
   * YYYY-MM-DD this pair was last read off the provider's published pricing
   * table. Not decoration: the provenance test fails once the NEWEST date here
   * is more than PRICE_SWEEP_MAX_AGE_DAYS old, which is the forcing function
   * for re-reading the whole list rather than the one model someone noticed.
   */
  checkedOn: string;
  /**
   * Set ONLY when the published rate is explicitly temporary and reverts on a
   * date the provider has named. The provenance test FAILS once that date is in
   * the past, so a promo cannot quietly become a wrong list price. Absent means
   * "this is the standing rate", which is the normal case.
   */
  provisionalUntil?: string;
  /** Where the pair was read. One URL, so re-checking is a click, not a hunt. */
  source: string;
}

const PRICE_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";

/**
 * Longest a rate may go un-re-read before the provenance test fails.
 *
 * This is a deliberate tripwire, not a guess at how often prices move. The
 * whole table drifted for months because nothing ever asked; half a year is
 * short enough to catch a live rate change and long enough that the alarm is
 * never routine. Clearing it means re-reading PRICE_SOURCE and bumping every
 * `checkedOn` — the sweep, not one row.
 */
export const PRICE_SWEEP_MAX_AGE_DAYS = 180;

// US-2568: keyed "<provider>:<model>". A second provider's rates land here
// beside these instead of colliding on a bare model id — two vendors can and do
// ship a model called "sonnet", and silently pricing one at the other's rate
// would corrupt the margin figure the whole dashboard exists to report.
//
// Lookup falls back to the bare model id so every row written before this change
// still prices correctly; see priceFor().
//
// US-3186: the KEYS come from MODEL_IDS (lib/ai-model-registry.ts); the rates
// stay here, because a price is a fact about a model and not a property of it.
// A row may be added freely. Deleting one is the trap: priceFor() answers 0 for
// an unknown id, so removing a previous-generation row reprices every
// historical call on that model to $0.00 with no error anywhere, and the bill
// appears to have fallen. RETAINED_MODEL_IDS names the rows that must stay and
// tests/ai-model-registry_test.ts fails if one goes missing.
export const MODEL_PRICES: Record<string, ModelPrice> = {
  [MODEL_IDS.opus5]: {
    inputPerMTok: 5,
    outputPerMTok: 25,
    checkedOn: "2026-09-11",
    source: PRICE_SOURCE,
  },
  [MODEL_IDS.opus48]: {
    inputPerMTok: 5,
    outputPerMTok: 25,
    checkedOn: "2026-09-11",
    source: PRICE_SOURCE,
  },
  // Sonnet 5 = the current DEFAULT_AI_MODEL, so this is the rate almost every
  // row in the ledger is priced at. It is CHEAPER than Sonnet 4.6, not equal to
  // it: the $2/$10 launch rate became the standard price, and the increase to
  // $3/$15 that this table had compiled in as "the list price" was cancelled.
  [MODEL_IDS.sonnet5]: {
    inputPerMTok: 2,
    outputPerMTok: 10,
    checkedOn: "2026-09-11",
    source: PRICE_SOURCE,
  },
  // RETAINED, do not delete. See the paragraph above the table.
  [MODEL_IDS.sonnet46]: {
    inputPerMTok: 3,
    outputPerMTok: 15,
    checkedOn: "2026-09-11",
    source: PRICE_SOURCE,
  },
  [MODEL_IDS.haiku45Dated]: {
    inputPerMTok: 1,
    outputPerMTok: 5,
    checkedOn: "2026-09-11",
    source: PRICE_SOURCE,
  },
  // Alias without the date suffix, in case DEFAULT_AI_MODEL is set to the bare id.
  [MODEL_IDS.haiku45]: {
    inputPerMTok: 1,
    outputPerMTok: 5,
    checkedOn: "2026-09-11",
    source: PRICE_SOURCE,
  },
};

// Anthropic's standard cache multipliers (relative to the input rate).
//
// These are per-provider constants, not per-model ones, and that holds for
// every model in the table above. It stops holding the moment a Fable or Mythos
// id is added: those price cache reads at 0.025× input, not 0.1×, so adding one
// here without moving the read multiplier onto ModelPrice would over-bill its
// cache reads fourfold. The provenance test names them for that reason.
const CACHE_WRITE_MULTIPLIER = 1.25; // 5-minute ephemeral cache write
const CACHE_READ_MULTIPLIER = 0.1; // cache read

/**
 * One priced call.
 *
 * US-2568: the token fields are AiUsage, the provider-neutral shape from
 * ai-provider.ts, rather than a mirror of Anthropic's SDK type. `providerId` is
 * what makes a second vendor's spend legible on the same dashboard instead of
 * reading as $0 against an unknown model id.
 */
export interface AiTokenUsage extends AiUsage {
  model: string;
  /** Defaults to "anthropic" — every row written before US-2568. */
  providerId?: string;
}

// Normalize whatever a provider reported into the priced shape. Accepts the
// SDK's snake_case usage object as well as AiUsage, so a caller still holding a
// raw response does not have to translate first.
export function toAiTokenUsage(
  model: string,
  usage: unknown,
  providerId = "anthropic",
): AiTokenUsage {
  return { model, providerId, ...normalizeUsage(usage) };
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
/**
 * Rates for a (provider, model) pair.
 *
 * Tries "<provider>:<model>" first, then the bare model id. The fallback is what
 * keeps every pre-US-2568 row and every operator env override working unchanged
 * — an unknown pair prices at 0, which records the TOKENS and shows the cost as
 * zero rather than hiding the call entirely.
 */
function priceFor(usage: AiTokenUsage): ModelPrice | undefined {
  const provider = usage.providerId ?? "anthropic";
  return MODEL_PRICES[`${provider}:${usage.model}`] ?? MODEL_PRICES[usage.model];
}

export function computeCostUsd(usage: AiTokenUsage): number {
  const price = priceFor(usage);
  const modelKey = usage.model.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const inputRate = rate(`AI_PRICE_INPUT_${modelKey}`, price?.inputPerMTok);
  const outputRate = rate(`AI_PRICE_OUTPUT_${modelKey}`, price?.outputPerMTok);

  const cost =
    (usage.inputTokens * inputRate +
      usage.outputTokens * outputRate +
      usage.cacheWriteTokens * inputRate * CACHE_WRITE_MULTIPLIER +
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
      cache_creation_tokens: usage.cacheWriteTokens,
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
    cache_creation_tokens: input.usage.cacheWriteTokens,
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
