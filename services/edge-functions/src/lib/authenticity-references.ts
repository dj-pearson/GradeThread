// US-2218: known-genuine reference imagery for authentication tells.
//
// HALF THE TELL TAXONOMY IS VISUAL. `stitching`, `font`, `stamp`, `hardware`
// and `construction` describe how something LOOKS, and none of them can be
// checked from prose. The seeded content says so itself: the Louis Vuitton
// stamp tell instructs the reader to "compare letter spacing/shape to a
// known-genuine reference" — an artifact that did not exist anywhere in the
// system. A tell whose check instruction depends on something we do not have
// is not a checkable rule; it is a sentence that reads like one.
//
// This module owns which tells NEED a reference, whether one exists, and what
// its absence costs. It is distinct from US-2139 (tell depth and
// counterfeit-side modelling) and US-2138 (decoder cross-checks): those assume
// this evidence layer, and it was missing.
//
// ── ABSENCE LOWERS CONFIDENCE; IT NEVER RAISES A SUSPICION ─────────────────
//
// A visual tell we cannot check is a gap in OUR evidence, not a mark against
// the garment. So a missing reference widens the disclosed limitations and caps
// confidence — it must never push the verdict toward red flags, because that
// would convert our own incompleteness into an accusation about a seller's
// item. The cap composes by min-of-caps and can only lower (grading-engine
// contract).
//
// Pure logic + one cached read. The rights/consent posture is enforced in the
// schema (00500): `rights` is NOT NULL and there is no path from
// submission_images.

import { supabaseAdmin } from "./supabase.ts";
import type { AuthenticationTell, AuthTellCategory } from "./brand-authenticity.ts";

/**
 * Tell categories that are checked BY LOOKING. A tell in one of these is only
 * as good as the reference it can be compared against.
 *
 * The rest — date_code, serial, packaging, material, other — are checked by
 * reading, measuring or handling, so they stay verifiable without imagery.
 */
export const VISUAL_TELL_CATEGORIES: ReadonlySet<AuthTellCategory> = new Set([
  "stitching",
  "font",
  "stamp",
  "hardware",
  "construction",
]);

/** One curated reference image, as stored. */
export interface AuthenticityReference {
  brandKey: string;
  style: string;
  tellCategory: string;
  storagePath: string;
  caption: string;
  source: string;
  rights: string;
  confidence: number | null;
  verified: boolean;
}

/**
 * Signed-URL TTL. Matches the submission-images rule (<= 900s) because the
 * exposure is the same shape: a private object briefly readable by URL.
 */
export const REFERENCE_SIGNED_URL_TTL_SECONDS = 900;

/**
 * The bucket. PRIVATE — never `item-photos`, which is the only public one.
 *
 * Whatever eventually shows these images to a reviewer must reach them through
 * `signReferenceUrl` below. NEVER a public URL: that link does not expire, and a
 * reference image is a private asset.
 */
export const REFERENCE_BUCKET = "authenticity-references";

/** A tell paired with whether we can actually check it visually. */
export interface TellVerifiability {
  tell: AuthenticationTell;
  /** True when the tell is visual AND we hold no reference for it. */
  visuallyUnverifiable: boolean;
  /** References available for this tell's category (may be empty). */
  references: AuthenticityReference[];
}

/**
 * Pair each tell with the references that could support it. A tell is
 * `visuallyUnverifiable` only when it is BOTH visual and unreferenced —
 * a date-code tell with no imagery is perfectly checkable and must not be
 * marked, or the limitation text becomes noise that reviewers learn to ignore.
 *
 * Pure — exported for tests.
 */
export function assessTellVerifiability(
  tells: readonly AuthenticationTell[],
  references: readonly AuthenticityReference[],
): TellVerifiability[] {
  return tells.map((tell) => {
    const forCategory = references.filter(
      (r) => r.tellCategory === tell.category,
    );
    const isVisual = VISUAL_TELL_CATEGORIES.has(tell.category);
    return {
      tell,
      visuallyUnverifiable: isVisual && forCategory.length === 0,
      references: forCategory,
    };
  });
}

/**
 * The confidence ceiling implied by unreferenced visual tells. Returns 1 (no
 * cap) when everything checkable is checkable.
 *
 * Deliberately coarse — two bands, not a formula. A fine-grained curve here
 * would imply a precision we do not have: we know that a visual tell without a
 * reference was reasoned about from model memory rather than checked, and we do
 * not know how much that costs. Two honest bands beat a fabricated gradient.
 */
export const REFERENCE_CAP_SOME = 0.8;
export const REFERENCE_CAP_ALL = 0.6;

export function referenceConfidenceCap(
  verifiability: readonly TellVerifiability[],
): number {
  const visual = verifiability.filter((v) =>
    VISUAL_TELL_CATEGORIES.has(v.tell.category)
  );
  if (visual.length === 0) return 1;
  const unreferenced = visual.filter((v) => v.visuallyUnverifiable).length;
  if (unreferenced === 0) return 1;
  // Every visual tell unchecked: the visual half of the assessment rested
  // entirely on model memory.
  if (unreferenced === visual.length) return REFERENCE_CAP_ALL;
  return REFERENCE_CAP_SOME;
}

/**
 * The sentence appended to the disclosed limitations. Returns "" when nothing
 * is unverifiable, keeping the limitations text byte-identical to today.
 *
 * Names the CATEGORIES rather than a count, because "we could not check the
 * stitching or the stamp" tells a reader something actionable and "3 tells
 * unverified" does not.
 */
export function referenceLimitation(
  verifiability: readonly TellVerifiability[],
): string {
  const cats = [
    ...new Set(
      verifiability
        .filter((v) => v.visuallyUnverifiable)
        .map((v) => v.tell.category),
    ),
  ].sort();
  if (cats.length === 0) return "";
  return ` We hold no known-genuine reference imagery for this brand's ${
    cats.join(", ")
  } tells, so those were assessed from description alone and not compared against a verified example; treat them as weaker evidence.`;
}

/**
 * Render the reference captions available to the assessment prompt. IMAGE
 * BYTES ARE NOT INLINED HERE: the captions and their provenance are what the
 * text pass can use, and shipping reference photos into every authenticity call
 * would multiply its cost for a benefit that has not been evaluated. Presenting
 * the image alongside the suspect region is the reviewer-facing step, which is
 * why the signed-URL helper is separate.
 */
export function referenceCaptionBlock(
  verifiability: readonly TellVerifiability[],
): string {
  const lines: string[] = [];
  for (const v of verifiability) {
    for (const r of v.references) {
      if (!r.caption) continue;
      lines.push(`- [${r.tellCategory}] ${r.caption}`);
    }
  }
  if (lines.length === 0) return "";
  return [
    "<<<KNOWN_GENUINE_REFERENCES — descriptions of verified genuine examples we hold>>>",
    ...lines,
    "<<<END_KNOWN_GENUINE_REFERENCES>>>",
  ].join("\n");
}

// ── Data access ─────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<
  string,
  { refs: AuthenticityReference[]; expires: number }
>();

/** Test seam. */
export function resetReferenceCache(): void {
  cache.clear();
}

/**
 * Load the references for a brand. On ANY error the result is an empty list,
 * which degrades to "we hold no references" — the same state as a brand we
 * never curated, and one that lowers confidence rather than raising suspicion.
 */
export async function getAuthenticityReferences(
  brandKey: string,
): Promise<AuthenticityReference[]> {
  const key = brandKey.trim().toLowerCase();
  if (!key) return [];
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.refs;
  try {
    const { data, error } = await supabaseAdmin
      .from("authenticity_references")
      .select(
        "brand_key, style, tell_category, storage_path, caption, source, rights, confidence, verified",
      )
      .eq("brand_key", key);
    if (error) throw error;
    const refs: AuthenticityReference[] = (data ?? []).map((r) => {
      const row = r as Record<string, unknown>;
      return {
        brandKey: String(row.brand_key ?? ""),
        style: String(row.style ?? ""),
        tellCategory: String(row.tell_category ?? ""),
        storagePath: String(row.storage_path ?? ""),
        caption: String(row.caption ?? ""),
        source: String(row.source ?? ""),
        rights: String(row.rights ?? ""),
        confidence: typeof row.confidence === "number" ? row.confidence : null,
        verified: row.verified === true,
      };
    });
    cache.set(key, { refs, expires: Date.now() + CACHE_TTL_MS });
    return refs;
  } catch (err) {
    console.error(
      "[authenticity-references] load failed (treated as no references):",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

/**
 * Short-lived signed URL for a reference image, for the REVIEWER surface.
 * Never `getPublicUrl` — these objects live in a private bucket and a public
 * URL would be permanent.
 *
 * US-2363 DECIDED: KEEP, though nothing calls it yet. It is the only reader in
 * this module, and US-2218's privacy contract requires that the module's reads
 * be signed — `authenticity-references_test.ts` asserts `createSignedUrl`
 * appears here, so deleting it would not have removed dead code, it would have
 * removed the sanctioned way to read the bucket and pushed the next person to
 * invent one. Unused here means the reviewer surface is not built yet.
 */
export async function signReferenceUrl(
  storagePath: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin.storage
      .from(REFERENCE_BUCKET)
      .createSignedUrl(storagePath, REFERENCE_SIGNED_URL_TTL_SECONDS);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}
