// US-3444: reading an `ai_field_sources` entry safely, in one place.
//
// The column is `jsonb NOT NULL DEFAULT '{}'` (00024) with no check constraint
// on its interior, so what a reader gets back is whatever some client wrote.
// Two shapes exist in production and both are legitimate:
//
//   { source, confidence, accepted }   the edge, the web composer and iOS
//   "photo:tag"                        Android (US-3358), the source alone
//
// A reader that indexes an entry directly gets `undefined` off the string form
// and renders it. That was live: the measurement form's AI badge read
// `ai.confidence * 100` and `ai.source` straight off the entry, so an
// Android-written measurement showed `NaN% confident, undefined` in its
// tooltip. The edge already widened its own reader for this
// (`hasProvenanceEntry` in reextract-policy.ts); this is the same widening on
// the web side.
//
// These functions are pure and have no React and no Supabase in them on
// purpose: the point is that every surface answers the same way.

import type { AiFieldSource, AiFieldSourceEntry } from "@/types/database";

/**
 * The object form of an entry, or null when there is not one.
 *
 * A bare string says an AI pass wrote the field and nothing else, which is
 * exactly as much as it says about OWNERSHIP and strictly less than the object
 * says about CONFIDENCE. Callers that need a number must handle the null.
 */
export function asAiFieldSource(
  entry: AiFieldSourceEntry | null | undefined,
): AiFieldSource | null {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === "string") return null;
  if (typeof entry !== "object") return null;
  const source = (entry as AiFieldSource).source;
  const confidence = (entry as AiFieldSource).confidence;
  if (typeof source !== "string" || typeof confidence !== "number") return null;
  return entry as AiFieldSource;
}

/** Did an AI pass write this field, whatever shape the entry is in?
 *
 *  Mirrors `hasProvenanceEntry` in the edge's reextract-policy.ts, including
 *  its refusal of a number, a boolean and an empty string -- no client has ever
 *  written one, and reading one as AI-owned would license overwriting a value
 *  the seller may have typed.
 *
 *  ONE DIFFERENCE FROM THE EDGE, AND IT IS DELIBERATE: `source: "manual"` is
 *  NOT AI. measurement-photo-editor.tsx writes
 *  `{ source: "manual", measuredAt }` for every field the seller measured off
 *  a photo, and the badge below used to render "AI" over those -- with
 *  `NaN% confident, manual` in the tooltip, because that entry carries no
 *  confidence. The edge is left alone on purpose: `isAiOwned` is only ever
 *  asked about COLUMNS and ATTRIBUTE keys, never about a `measurements.<field>`
 *  key, so no re-extract path can see a manual entry and the two readers do not
 *  disagree about anything either of them is asked. */
export function isAiWritten(
  entry: AiFieldSourceEntry | null | undefined,
): boolean {
  if (typeof entry === "string") return entry.trim() !== "" && entry !== "manual";
  if (entry === null || entry === undefined || typeof entry !== "object") {
    return false;
  }
  return (entry as { source?: unknown }).source !== "manual";
}

/** The four readings of `accepted`, kept apart (US-3352).
 *
 *  `unknown` is a real answer and is not folded into the others: an entry
 *  written before the tri-state rule carries no key, and today's `accepted`
 *  count is an upper bound rather than a measurement because of it. A bare
 *  string is `unknown` too -- Android records no acceptance at all. */
export type Acceptance = "accepted" | "rejected" | "not_shown" | "unknown";

export function readAcceptance(
  entry: AiFieldSourceEntry | null | undefined,
): Acceptance {
  const obj = asAiFieldSource(entry);
  if (!obj) return "unknown";
  if (!("accepted" in obj)) return "unknown";
  if (obj.accepted === true) return "accepted";
  if (obj.accepted === false) return "rejected";
  if (obj.accepted === null) return "not_shown";
  return "unknown";
}
