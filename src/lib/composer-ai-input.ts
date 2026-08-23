/**
 * What the composer sends to `POST /api/flipdesk/ai/extract` (US-2817).
 *
 * Two modes, and the difference between them is the whole feature:
 *
 *  • `gap_fill` — the original "Complete with AI". Every filled field goes up
 *    as `known_fields`, and the route drops any suggestion for a known field
 *    ("never contradict caller-supplied known fields"). Result: proposals for
 *    the blanks only.
 *  • `reidentify` — "Re-run AI" on an item an older model already catalogued.
 *    NO known fields are sent, so the route has nothing to suppress and every
 *    field comes back as a suggestion, including ones already filled. The
 *    review panel then shows each as "Replaces current value", switched off by
 *    default, so a re-run proposes and the seller disposes.
 *
 * The free text follows the same logic. An AutoLister title is generated copy
 * naming the brand under review; handing it back is how you get the same wrong
 * answer twice. So in re-identify mode the title and description are withheld
 * whenever there are photos to read instead. Condition notes always go — the
 * seller wrote them, and they describe wear rather than identity.
 *
 * Mirrors services/edge-functions/src/lib/reextract-policy.ts, which applies
 * the same rules to the bulk path.
 */

export type ComposerAiMode = "gap_fill" | "reidentify";

export interface ComposerAiInputParts {
  title: string;
  description: string;
  conditionNotes: string;
  /** The enrichable fields and their current values, in send order. */
  fields: { key: string; value: unknown }[];
  photoCount: number;
}

export interface ComposerAiInput {
  text: string;
  known: Record<string, unknown>;
}

export function buildComposerAiInput(
  parts: ComposerAiInputParts,
  mode: ComposerAiMode,
): ComposerAiInput {
  const withholdCopy = mode === "reidentify" && parts.photoCount > 0;
  const chunks = withholdCopy
    ? [parts.conditionNotes]
    : [parts.title, parts.description, parts.conditionNotes];
  const text = chunks.filter((t) => t.trim() !== "").join("\n");

  const known: Record<string, unknown> = {};
  if (mode === "gap_fill") {
    for (const f of parts.fields) {
      if (String(f.value ?? "").trim()) known[f.key] = f.value;
    }
  }
  return { text, known };
}
