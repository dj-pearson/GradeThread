/**
 * Re-identify policy (US-2817).
 *
 * `POST /api/flipdesk/ai/bulk-extract` has always been a GAP FILLER: it tells
 * the model everything the item already carries, then writes only into columns
 * that are still empty. That is right for a fresh intake and wrong for the case
 * this module exists for — a seller with months-old drafts asking to run them
 * through a materially better identifier. Under gap-fill semantics that run
 * costs an AI action per item and provably changes nothing, because every
 * column the new model would improve is already occupied by the old model's
 * answer, and the old answer was fed back in as ground truth.
 *
 * Re-identify mode inverts both halves, and the pivot for both is PROVENANCE:
 *
 *  • **Withhold the AI's own past answers.** A value carrying an
 *    `ai_field_sources` entry was written by an extraction pass, so it is not
 *    evidence — echoing it back into `known_fields` is the model grading its
 *    own homework. A value with no entry was typed by the seller and IS
 *    evidence, so it still goes in.
 *  • **Overwrite only what the AI owns.** A confident new value may replace an
 *    AI-written one. It may never replace a seller-typed one; that goes to
 *    `pending` for a human to look at, exactly as a conflict does.
 *
 * The same rule governs the free-text prompt input. An AutoLister title is
 * generated copy that names the old brand, so in re-identify mode it is
 * withheld whenever photos can carry the pass on their own.
 *
 * Pure functions, no I/O — the route owns the DB and the model call.
 */

export type ExtractMode = "gap_fill" | "reidentify";

/**
 * How to read a column that carries NO provenance entry at all.
 *
 * This is the awkward half of the design and it decides whether the feature
 * does anything on real data. Provenance is written where an AI pass APPLIES a
 * value server-side, and for the enrichable columns that is a narrow set: the
 * `/extract` route stamps sources for canonical attributes, but brand, style,
 * size, colour and material are applied by the CLIENT after the seller reviews
 * them, and no client recorded a source until US-2817. So on drafts from before
 * that, brand is AI-written and looks seller-typed.
 *
 *  • `respect` (the default) — no entry means hands off. Safe, and on legacy
 *    stock it means a re-identify pass reports rather than corrects.
 *  • `treat_as_ai` — no entry means the AI probably wrote it, so it may be
 *    replaced. This is what makes the feature work on the drafts it exists for,
 *    and it is why the seller opts in per run rather than getting it silently:
 *    it cannot tell a stale AI answer from something typed by hand.
 *
 * A field WITH an entry is unaffected either way.
 */
export type UntrackedPolicy = "respect" | "treat_as_ai";

/** The `ai_field_sources` jsonb as it comes off `inventory_items`. */
export type AiFieldSources = Record<string, unknown>;

/**
 * True when this column/attribute key was last written by an AI pass rather
 * than by the seller.
 *
 * Provenance is recorded ONLY when a pass applies a value, so absence means
 * "not AI's" — which covers both a seller-typed value and a value that predates
 * provenance tracking. Treating an untracked value as seller-owned is the safe
 * direction: the cost is that an old un-provenanced AI value needs a human
 * click, versus silently overwriting something a seller typed by hand.
 */
export function isAiOwned(
  sources: AiFieldSources | null | undefined,
  field: string,
  untracked: UntrackedPolicy = "respect",
): boolean {
  const entry = sources?.[field];
  if (entry && typeof entry === "object") return true;
  // No entry. Under `respect` that ends it; under the seller's opt-in it counts
  // as AI-written so pre-provenance stock can actually be corrected.
  return untracked === "treat_as_ai";
}

/** Trimmed string form of whatever a column currently holds. */
function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/** True for a column/attribute value that counts as "nothing there yet". */
export function isEmptyValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return asText(value) === "";
}

/**
 * Which of the item's current column values to hand the model as ground truth.
 *
 * Gap-fill sends everything non-empty. Re-identify sends only what the AI did
 * not write, so the pass re-derives brand/style/size from the photos instead of
 * confirming an identification it made itself.
 */
export function buildKnownFields(
  item: Record<string, unknown>,
  columns: readonly string[],
  sources: AiFieldSources | null | undefined,
  mode: ExtractMode,
  untracked: UntrackedPolicy = "respect",
): Record<string, unknown> {
  const known: Record<string, unknown> = {};
  for (const col of columns) {
    const value = item[col];
    if (isEmptyValue(value)) continue;
    if (mode === "reidentify" && isAiOwned(sources, col, untracked)) continue;
    known[col] = value;
  }
  return known;
}

/**
 * The free-text block that goes into the prompt alongside the photos.
 *
 * In re-identify mode the title and description are withheld WHEN there are
 * photos to read instead: on an AutoLister draft both are generated copy that
 * repeat the identification under review, and leaving them in is the surest way
 * to get the same wrong brand back. `condition_notes` stays either way — it is
 * seller-authored and describes wear, not identity.
 *
 * With no photos there is nothing else to work from, so the full text is used
 * rather than sending an empty prompt.
 */
export function buildExtractText(
  parts: {
    title?: string | null;
    description?: string | null;
    conditionNotes?: string | null;
  },
  hasPhotos: boolean,
  mode: ExtractMode,
): string {
  const withhold = mode === "reidentify" && hasPhotos;
  const chunks = withhold
    ? [parts.conditionNotes]
    : [parts.title, parts.description, parts.conditionNotes];
  return chunks
    .filter((t): t is string => typeof t === "string" && t.trim() !== "")
    .join("\n");
}

/**
 * What to do with one suggested value.
 *
 *  • `apply`   — write it into an empty column.
 *  • `replace` — write it OVER an AI-written value (re-identify only).
 *  • `pending` — leave the column alone and surface it for review.
 *  • `skip`    — the AI restated what is already there; not a change, and not
 *                something to make a human look at either.
 */
export type FieldDecision = "apply" | "replace" | "pending" | "skip";

export function decideField(input: {
  current: unknown;
  suggested: string;
  confidence: number;
  autoApplyConfidence: number;
  conflicted: boolean;
  aiOwned: boolean;
  mode: ExtractMode;
}): FieldDecision {
  const current = asText(input.current);
  const suggested = input.suggested.trim();
  if (!suggested) return "skip";

  // Same answer as last time. Counting this as `pending` would tell a seller
  // that three items "need review" when the AI agreed with all three.
  if (current && current.toLowerCase() === suggested.toLowerCase()) {
    return "skip";
  }

  const confident =
    input.confidence >= input.autoApplyConfidence && !input.conflicted;
  if (!confident) return "pending";
  if (!current) return "apply";

  // Occupied. Only a re-identify pass may overwrite, and only over the AI's own
  // earlier answer.
  if (input.mode === "reidentify" && input.aiOwned) return "replace";
  return "pending";
}
