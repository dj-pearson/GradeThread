// US-3330: the one flaw that keeps a grade from the next level, as one
// sentence. The server decides which flaw (services/edge-functions/src/lib/
// limiting-flaw.ts) and sends words only; this only phrases it.

export interface LimitingFlaw {
  defect: string;
  location: string;
  next_tier: string;
}

/** "The small stain (left cuff) is what keeps this from Excellent." or null. */
export function limitingFlawSentence(f: LimitingFlaw | null | undefined): string | null {
  if (!f || !f.defect?.trim() || !f.next_tier?.trim()) return null;
  const defect = f.defect.trim();
  const lead = defect.charAt(0).toLowerCase() + defect.slice(1);
  const where = f.location?.trim() ? ` (${f.location.trim()})` : "";
  return `The ${lead}${where} is what keeps this from ${f.next_tier.trim()}.`;
}
