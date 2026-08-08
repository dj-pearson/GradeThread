// US-2438: the per-block versioned seam for the grading USER message.
//
// Only the SYSTEM prompt has ever been versioned. `resolveActivePrompt` returns
// one `text` that becomes the `system` block; everything `buildUserPrompt` and
// `buildCompositeUserPrompt` assemble — the garment-type criteria, the category
// criteria, the response schema — is reachable by no `ai_prompt_versions` row.
// So editing one of those blocks changes live grading on the next deploy, with
// an env flag as the only control. A flag is a switch: it answers "can we turn
// this off again" and says nothing about whether turning it on was a good idea.
// `prompt_surface_hash` (00562) makes that window visible after the fact; it
// cannot close it.
//
// WHY A SECOND TABLE, decided in US-2432 and recorded in full at
// vault/20-domain/grading-prompt-channels.md — DO NOT RE-DERIVE IT. Folding the
// blocks into `ai_prompt_versions.prompt_text` fails the one question that
// matters: can a scoped row vary ONE block without restating the prompt? It
// cannot. `garment_scope` has been a WHOLE-TEXT override since 00050 with no
// composition, so a row changing only CATEGORY CRITERIA for jeans carries a copy
// of the ~90-line response schema too, and 19 scoped categories means 19 copies
// of one invariant. That is the title-sync shape (US-1995), not a size gripe.
//
// ── WHAT THIS MODULE IS NOT ──
//
// It is NOT a resolver. `resolveSlotFromRows` and `pickPromptForBucket` in
// canary-rollout.ts do the resolving, unchanged, exactly as they do for the
// system prompt — scoped row, else global row, else the code default; canary
// bucketed per submission by a stable hash. AC1 asks for "the SAME path, not a
// parallel resolver", and a second copy of that precedence logic is precisely
// how the two would come to disagree about what a scoped row means.
//
// What this module owns is the three things that ARE new: which block keys
// exist, one DB read per stage instead of one per block, and the guarantee that
// an empty registry leaves every prompt byte-identical.

import { supabaseAdmin } from "./supabase.ts";
import { createVersionedCache } from "./coherent-cache.ts";
import {
  pickPromptForBucket,
  type ResolvedPrompt,
  resolveSlotFromRows,
  type SlotPromptRow,
} from "./canary-rollout.ts";

export type PromptStage = "per_image" | "composite";

/**
 * The CLOSED block vocabulary. A row naming a key that is not here resolves
 * nothing — it is inert, not an error.
 *
 * That is deliberate and it cuts the safe way. The alternative, treating an
 * unknown key as a failure, would turn a typo in an admin form into a grading
 * outage; treating it as a wildcard would let a typo replace some OTHER block.
 * Inert means a mistyped row simply never serves, which is visible the moment
 * anyone checks whether their override took effect.
 *
 * Each key also declares WHICH dimension its `garment_scope` matches. The column
 * only holds a value; what that value is compared against is code's decision,
 * and writing it down here is what stops `garment_scope: "jeans"` being read as
 * a garment_type on one block and a garment_category on another.
 */
export const PROMPT_BLOCK_KEYS = {
  /** GARMENT-TYPE CRITERIA in the per-image prompt. Scoped by garment_type. */
  garment_type_criteria: { stage: "per_image", scopeDimension: "garment_type" },
  /** CATEGORY CRITERIA in the per-image prompt. Scoped by garment_category. */
  category_criteria: { stage: "per_image", scopeDimension: "garment_category" },
} as const satisfies Record<
  string,
  { stage: PromptStage; scopeDimension: "garment_type" | "garment_category" }
>;

export type PromptBlockKey = keyof typeof PROMPT_BLOCK_KEYS;

/** Every key the registry currently covers, in a stable order. */
export const COVERED_BLOCK_KEYS: readonly PromptBlockKey[] = Object.keys(
  PROMPT_BLOCK_KEYS,
).sort() as PromptBlockKey[];

/**
 * A resolved block: the text to render and the version name that produced it.
 *
 * Structurally a {@link ResolvedPrompt} on purpose — it goes through the same
 * resolver, so it is the same thing at a different scale.
 */
export type ResolvedBlock = ResolvedPrompt;

/** The overrides one prompt build may consume. Absent key = code default. */
export type PromptBlockOverrides = Partial<
  Record<PromptBlockKey, ResolvedBlock>
>;

/**
 * The SAME cache signal the system prompt uses, and that is the point.
 *
 * A block activation and a prompt activation both have to drop both caches, and
 * two signals would mean two things to remember at every write site — with the
 * failure being silent (a replica serving the old block for up to its TTL, which
 * looks exactly like the activation not having happened yet). One signal makes
 * the existing `invalidatePromptCache()` calls in grading-eval.ts and
 * admin-grading.ts correct for blocks too, without editing any of them.
 */
const PROMPT_CACHE_SIGNAL = "grading-prompt";

/**
 * A slot row carrying the block it belongs to.
 *
 * `SlotPromptRow` deliberately, so canary-rollout's resolver reads it without
 * knowing this table exists; `block_key` is the extra field this module filters
 * on before handing a subset over.
 */
export type BlockSlotRow = SlotPromptRow & { block_key: string };

/** All live (active or canary) block rows for one stage, cached per stage. */
const blockCache = createVersionedCache<BlockSlotRow[]>({
  signalKey: PROMPT_CACHE_SIGNAL,
});

/** Drop the cached block rows cluster-wide. Shares the prompt signal. */
export async function invalidatePromptBlockCache(): Promise<void> {
  await blockCache.invalidate();
}

/** One row as it comes back from the table. */
interface BlockRow {
  version_name: string;
  block_key: string;
  block_text: string | null;
  garment_scope: string | null;
  is_active: boolean;
  is_canary: boolean;
  rollout_percentage: number | null;
}

/**
 * Load every live block row for a stage in ONE query.
 *
 * Per-block queries would multiply a grading call's database round-trips by the
 * number of blocks for no gain — the rows are tiny and the filter is the same.
 * Never throws: a DB hiccup yields an empty set, which resolves every block to
 * its code default, i.e. the prompt that shipped.
 */
async function loadBlockRows(stage: PromptStage): Promise<BlockSlotRow[]> {
  return await blockCache.get(`blocks:${stage}`, async () => {
    try {
      const { data, error } = await supabaseAdmin
        .from("ai_prompt_block_versions")
        .select(
          "version_name, block_key, block_text, garment_scope, is_active, is_canary, rollout_percentage",
        )
        .eq("stage", stage)
        .or("is_active.eq.true,is_canary.eq.true");

      if (error || !Array.isArray(data)) return [];
      // block_text maps onto prompt_text so canary-rollout's resolver reads it
      // without knowing this table exists. Its "" means "use the code default
      // text under this version_name", which is the same contract
      // ai_prompt_versions.prompt_text already has.
      return (data as BlockRow[]).map((r) => ({
        version_name: r.version_name,
        prompt_text: r.block_text,
        garment_scope: r.garment_scope,
        is_active: r.is_active,
        is_canary: r.is_canary,
        rollout_percentage: r.rollout_percentage,
        block_key: r.block_key,
      }));
    } catch (err) {
      console.error(
        `[prompt-blocks] load failed (${stage}) — falling back to code defaults:`,
        err instanceof Error ? err.message : String(err),
      );
      return [];
    }
  });
}

/**
 * The version name a block carries when the CODE default won.
 *
 * A sentinel rather than a per-block constant because it is never reported on
 * its own: {@link resolvePromptBlocks} drops any block that resolved to it, so
 * this string reaching a grade record would mean the drop failed.
 */
export const CODE_DEFAULT_BLOCK_VERSION = "code";

/** Wrap the text code ships as the default for a block. */
export function codeDefaultBlock(text: string): ResolvedBlock {
  return { text, versionName: CODE_DEFAULT_BLOCK_VERSION };
}

/** One block to resolve: its key, its scope value, and the text code ships. */
export interface BlockRequest {
  key: PromptBlockKey;
  /** The scope value for this key's dimension, or null for the global slot. */
  scope: string | null;
  codeDefault: ResolvedBlock;
}

/**
 * Resolve a set of blocks for one stage.
 *
 * Returns ONLY the keys whose resolved text differs from the code default — an
 * empty registry therefore returns `{}`, and a caller that spreads the result
 * over its defaults produces the prompt that shipped, byte for byte. That is
 * the additive guarantee AC1 asks for, and it is a property of this return
 * shape rather than of the call sites remembering to check.
 *
 * A row with empty `block_text` resolves to the code default TEXT under the
 * row's version name. That is a real override — it names an era without
 * duplicating the text — so it is returned, and the text still matches.
 */
export async function resolvePromptBlocks(
  stage: PromptStage,
  requests: BlockRequest[],
  bucketKey?: string,
): Promise<PromptBlockOverrides> {
  if (requests.length === 0) return {};
  return resolveBlocksFromRows(
    stage,
    requests,
    await loadBlockRows(stage),
    bucketKey,
  );
}

/**
 * The resolution itself, with the rows already in hand. Pure — every branch
 * above is reachable in a test with no database and no vision call, the same
 * reason canary-rollout.ts is pure.
 */
export function resolveBlocksFromRows(
  stage: PromptStage,
  requests: BlockRequest[],
  rows: BlockSlotRow[],
  bucketKey?: string,
): PromptBlockOverrides {
  if (requests.length === 0 || rows.length === 0) return {};

  const out: PromptBlockOverrides = {};
  for (const req of requests) {
    // Guard the vocabulary at the READ side too, not only at the write side:
    // this function is the only thing standing between a row and a live prompt.
    if (!(req.key in PROMPT_BLOCK_KEYS)) continue;
    if (PROMPT_BLOCK_KEYS[req.key].stage !== stage) continue;

    const forKey = rows.filter((r) => r.block_key === req.key);
    if (forKey.length === 0) continue;

    const slot = resolveSlotFromRows(forKey, req.scope, req.codeDefault);
    // Namespaced by key AND scope so a submission bucketed into the canary for
    // one block is bucketed INDEPENDENTLY for the next — the same property
    // canaryBucket already gives the per-image and composite slots.
    const resolved = pickPromptForBucket(
      slot,
      `block:${stage}:${req.key}:${req.scope ?? ""}`,
      bucketKey,
    );
    if (resolved.versionName === req.codeDefault.versionName) continue;
    out[req.key] = resolved;
  }
  return out;
}

/** One active block override, as reported alongside an eval run. */
export interface ActiveBlockVersion {
  blockKey: string;
  garmentScope: string | null;
  versionName: string;
}

/**
 * Every ACTIVE block override for a stage, for reporting rather than serving.
 *
 * This exists because the seam opened a hole in the fingerprint it sits beside.
 * `unversionedPromptSurfaceHash()` digests the CODE DEFAULTS, so once a block row
 * can replace one of those defaults at runtime, the hash stops describing what
 * actually ran — two eval runs under different block versions would carry the
 * SAME hash and read as comparable. That is worse than no fingerprint, because
 * the whole point of the hash is to say "these two runs measured different
 * prompts, do not compare their MAE".
 *
 * Canaries are deliberately excluded: an eval run has no bucketKey, so it never
 * takes a canary slice, and listing one would describe traffic this run did not
 * serve.
 */
export async function activeBlockVersions(
  stage: PromptStage,
): Promise<ActiveBlockVersion[]> {
  const rows = await loadBlockRows(stage);
  return rows
    .filter((r) => r.is_active)
    .map((r) => ({
      blockKey: r.block_key,
      garmentScope: r.garment_scope,
      versionName: r.version_name,
    }))
    // Sorted so two runs with the same overrides produce the same report
    // regardless of row order, the same reason the version suffix sorts.
    .sort((a, b) =>
      `${a.blockKey}:${a.garmentScope ?? ""}`.localeCompare(
        `${b.blockKey}:${b.garmentScope ?? ""}`,
      )
    );
}

/**
 * The version suffix a grade records for the blocks that actually served.
 *
 * Empty string when nothing overrode, so `prompt_version` is unchanged on every
 * grade run against an empty registry — the same additive rule the text follows.
 * Sorted by key so two grades that ran the same overrides produce the same
 * string regardless of resolution order.
 */
export function blockVersionSuffix(overrides: PromptBlockOverrides): string {
  const parts = (Object.keys(overrides) as PromptBlockKey[])
    .sort()
    .map((k) => `${k}=${overrides[k]!.versionName}`);
  return parts.length === 0 ? "" : `+blocks(${parts.join(",")})`;
}
