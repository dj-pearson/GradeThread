// US-3321: what "legible" means on a label photo.
//
// The per-image Rules block defined it as "the brand/size/care text is
// readable". A garment whose only tag is a silicone size dot (Lululemon), a
// heat-transfer neck print (Nike) or a waistband stamp has no care text at all,
// so a sharp, well-framed photo of it scored legible=false. That flag caps
// confidence at ILLEGIBLE_LABEL_CONFIDENCE_CAP and forces a human review
// (US-3320), for a label the model read perfectly well.
//
// v2 judges whether the marking that IS on the tag can be read, and names the
// tagless constructions so they stop reading as unread labels.
//
// This is prompt TEXT, so it ships through the grading-engine lifecycle rather
// than as an edit: behind GRADING_LEGIBLE_V2, default OFF. Off is byte-identical
// to the prompt that shipped. On, the per-image entry is stamped "+legible2" and
// the composite version carries "+legible2" too, so accuracy tracking can split
// the era. Shadow, the golden-set eval gate and a canary run with the flag on
// before it is turned on for everyone.
//
// Pure: no supabase.

export function legibleV2Enabled(): boolean {
  const v = (Deno.env.get("GRADING_LEGIBLE_V2") ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/** The exact clause in PER_IMAGE_RULES this replaces. */
export const LEGIBLE_V1_PHRASE =
  "legible: for a label/tag photo, true if the brand/size/care text is readable, false if not; for non-label photos set legible=true.";

export const LEGIBLE_V2_PHRASE =
  "legible: for a label/tag photo, true if the text or marking that IS on the tag can be read, even when the tag carries only part of brand, size and care. Tagless constructions are legible when their marking is readable: a heat-transfer print, a silicone size dot, a waistband stamp, a size-only tag. Set false only when marking that is present cannot be read (too blurred, faded, washed out, cut or out of frame). A garment that simply has no care text is not illegible. For non-label photos set legible=true.";

/**
 * Apply the v2 definition. `applied` is true only when the text changed, so a
 * rules override that does not carry the v1 clause is not mislabelled as the
 * "+legible2" era.
 */
export function applyLegibleWording(
  text: string,
  enabled: boolean = legibleV2Enabled(),
): { text: string; applied: boolean } {
  if (!enabled) return { text, applied: false };
  const out = text.split(LEGIBLE_V1_PHRASE).join(LEGIBLE_V2_PHRASE);
  return { text: out, applied: out !== text };
}
