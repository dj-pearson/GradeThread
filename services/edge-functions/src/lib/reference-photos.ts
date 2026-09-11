// US-3334: the admin reference gallery - a graded photo awarded as the example
// of a grade level ("this is what a 7 looks like" for jeans).
//
// The table (grading_reference_photos, 00789) is deny-all; every read and
// write comes through here, from admin routes that require step-up and write
// an audit row.
//
// WHO MAY BE AWARDED is decided here, on the server, from the database - never
// from the request. A photo qualifies only when:
//   1. it belongs to a FINALIZED grade (a decided number, not a draft), and
//   2. the submission's owner is staff (users.role admin or super_admin) or has
//      opted into model refinement (users.share_sale_outcomes).
// Exemplar privacy forbids customer photos in prompts without that consent, and
// US-3335 is what puts these photos in front of the grader. Consent can be
// withdrawn after an award, so the list re-checks it and flags any award whose
// owner no longer qualifies; the consumer must skip those.
//
// Images stay in the PRIVATE submission-images bucket and leave only as signed
// URLs of REFERENCE_IMAGE_TTL seconds (US-276 caps these at 900).

import { supabaseAdmin } from "./supabase.ts";

export const REFERENCE_IMAGE_TTL = 900;
export const REFERENCE_NOTE_MAX = 500;
export const REFERENCE_LIST_MAX = 200;

export const REFERENCE_FACTORS = [
  "fabric_condition",
  "structural_integrity",
  "cosmetic_appearance",
  "functional_elements",
  "odor_cleanliness",
] as const;
export type ReferenceFactor = typeof REFERENCE_FACTORS[number];

const STAFF_ROLES = new Set(["admin", "super_admin"]);

/** What the server learned about one photo before an award. */
export interface AwardEligibility {
  imageFound: boolean;
  /** A grade_reports row with finalized_at set exists for the photo's submission. */
  finalized: boolean;
  ownerRole: string | null;
  ownerConsent: boolean;
}

/** Pure: staff-owned, or the owner opted in. */
export function ownerQualifies(
  role: string | null | undefined,
  consent: boolean | null | undefined,
): boolean {
  return STAFF_ROLES.has(role ?? "") || consent === true;
}

/** Pure: why a photo may not be awarded, or null when it may. */
export function referenceAwardRefusal(e: AwardEligibility): string | null {
  if (!e.imageFound) return "Photo not found.";
  if (!e.finalized) return "Only photos from a finalized grade can be awarded.";
  if (!ownerQualifies(e.ownerRole, e.ownerConsent)) {
    return "The owner has not opted into model refinement, so this photo cannot be used.";
  }
  return null;
}

export interface AwardInput {
  submissionImageId: string;
  factor: ReferenceFactor | null;
  awardedScore: number;
  note: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pure: validate an award request body. Returns the input or an error. */
export function parseAwardBody(body: unknown): AwardInput | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const id = typeof b.submission_image_id === "string" ? b.submission_image_id.trim() : "";
  if (!UUID_RE.test(id)) return { error: "submission_image_id must be a uuid" };
  let factor: ReferenceFactor | null = null;
  if (b.factor !== undefined && b.factor !== null && b.factor !== "") {
    if (!REFERENCE_FACTORS.includes(b.factor as ReferenceFactor)) {
      return { error: `factor must be one of ${REFERENCE_FACTORS.join(", ")}` };
    }
    factor = b.factor as ReferenceFactor;
  }
  const raw = typeof b.awarded_score === "number" ? b.awarded_score : Number(b.awarded_score);
  if (b.awarded_score === null || b.awarded_score === "" || !Number.isFinite(raw) || raw < 1 || raw > 10) {
    return { error: "awarded_score must be between 1.0 and 10.0" };
  }
  // A factor is graded in half steps; an overall to one decimal (the scale).
  const awardedScore = factor ? Math.round(raw * 2) / 2 : Math.round(raw * 10) / 10;
  const note = typeof b.note === "string" && b.note.trim()
    ? b.note.trim().slice(0, REFERENCE_NOTE_MAX)
    : null;
  return { submissionImageId: id, factor, awardedScore, note };
}

export interface AwardContext {
  eligibility: AwardEligibility;
  submissionId: string | null;
  gradeReportId: string | null;
  garmentCategory: string | null;
}

/**
 * Everything the award rule needs, read from the database by image id. The
 * caller never supplies the owner, the category or the grade.
 */
export async function loadAwardContext(submissionImageId: string): Promise<AwardContext> {
  const none: AwardContext = {
    eligibility: { imageFound: false, finalized: false, ownerRole: null, ownerConsent: false },
    submissionId: null,
    gradeReportId: null,
    garmentCategory: null,
  };
  const { data: img } = await supabaseAdmin
    .from("submission_images")
    .select("id, submission_id")
    .eq("id", submissionImageId)
    .maybeSingle();
  if (!img) return none;
  const submissionId = (img as { submission_id: string }).submission_id;
  const { data: sub } = await supabaseAdmin
    .from("submissions")
    .select("id, user_id, garment_category")
    .eq("id", submissionId)
    .maybeSingle();
  if (!sub) return none;
  const s = sub as { user_id: string; garment_category: string };
  const [{ data: report }, { data: owner }] = await Promise.all([
    supabaseAdmin
      .from("grade_reports")
      .select("id, finalized_at")
      .eq("submission_id", submissionId)
      .not("finalized_at", "is", null)
      .order("finalized_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from("users")
      .select("role, share_sale_outcomes")
      .eq("id", s.user_id)
      .maybeSingle(),
  ]);
  const o = (owner ?? null) as { role: string | null; share_sale_outcomes: boolean | null } | null;
  return {
    eligibility: {
      imageFound: true,
      finalized: !!report,
      ownerRole: o?.role ?? null,
      ownerConsent: o?.share_sale_outcomes === true,
    },
    submissionId,
    gradeReportId: (report as { id: string } | null)?.id ?? null,
    garmentCategory: s.garment_category,
  };
}

/**
 * The photos of one finalized grade, each with whether it may be awarded, so
 * the admin picks from what qualifies instead of guessing and being refused.
 */
export async function loadAwardCandidates(gradeReportId: string): Promise<{
  found: boolean;
  refusal: string | null;
  garment_category: string | null;
  overall_score: number | null;
  photos: Array<{ id: string; image_type: string; url: string | null }>;
}> {
  const { data: report } = await supabaseAdmin
    .from("grade_reports")
    .select("id, submission_id, overall_score, finalized_at")
    .eq("id", gradeReportId)
    .maybeSingle();
  if (!report) {
    return { found: false, refusal: "Grade not found.", garment_category: null, overall_score: null, photos: [] };
  }
  const r = report as { submission_id: string; overall_score: number | null; finalized_at: string | null };
  const { data: imgs } = await supabaseAdmin
    .from("submission_images")
    .select("id, image_type, storage_path, display_order")
    .eq("submission_id", r.submission_id)
    .order("display_order", { ascending: true });
  const images = (imgs ?? []) as Array<{ id: string; image_type: string; storage_path: string }>;
  const ctx = images.length > 0 ? await loadAwardContext(images[0].id) : null;
  const refusal = ctx
    ? referenceAwardRefusal({ ...ctx.eligibility, finalized: !!r.finalized_at })
    : "This grade has no photos.";
  let signed = new Map<string, string>();
  if (!refusal && images.length > 0) {
    signed = await signImages(images);
  }
  return {
    found: true,
    refusal,
    garment_category: ctx?.garmentCategory ?? null,
    overall_score: r.overall_score === null ? null : Number(r.overall_score),
    // No URLs for a photo that cannot be awarded: nothing to look at.
    photos: images.map((i) => ({ id: i.id, image_type: i.image_type, url: signed.get(i.id) ?? null })),
  };
}

async function signImages(
  images: Array<{ id: string; storage_path: string }>,
): Promise<Map<string, string>> {
  const { data: urls } = await supabaseAdmin.storage
    .from("submission-images")
    .createSignedUrls(images.map((i) => i.storage_path), REFERENCE_IMAGE_TTL);
  return new Map(
    (urls ?? [])
      .map((u, idx) => [images[idx].id, u.signedUrl] as [string, string | null])
      .filter((pair): pair is [string, string] => Boolean(pair[1])),
  );
}

export interface ReferencePhotoRow {
  id: string;
  submission_image_id: string;
  grade_report_id: string | null;
  garment_category: string;
  factor: ReferenceFactor | null;
  awarded_score: number;
  awarded_by: string;
  note: string | null;
  created_at: string;
}

export interface ReferencePhotoView extends ReferencePhotoRow {
  image_type: string | null;
  url: string | null;
  /** False when the owner has since withdrawn consent: never show the grader. */
  still_eligible: boolean;
}

/**
 * Live awards, filtered, with signed URLs and a fresh consent check. Revoked
 * rows are never returned.
 */
export async function listReferencePhotos(filter: {
  category?: string | null;
  factor?: ReferenceFactor | null;
  limit?: number;
}): Promise<ReferencePhotoView[]> {
  let q = supabaseAdmin
    .from("grading_reference_photos")
    .select(
      "id, submission_image_id, grade_report_id, garment_category, factor, awarded_score, awarded_by, note, created_at",
    )
    .is("revoked_at", null)
    .order("garment_category", { ascending: true })
    .order("awarded_score", { ascending: false })
    .limit(Math.min(filter.limit ?? REFERENCE_LIST_MAX, REFERENCE_LIST_MAX));
  if (filter.category) q = q.eq("garment_category", filter.category);
  if (filter.factor) q = q.eq("factor", filter.factor);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as ReferencePhotoRow[];
  if (rows.length === 0) return [];

  const { data: imgs } = await supabaseAdmin
    .from("submission_images")
    .select("id, submission_id, image_type, storage_path")
    .in("id", rows.map((r) => r.submission_image_id));
  const images = (imgs ?? []) as Array<{
    id: string;
    submission_id: string;
    image_type: string;
    storage_path: string;
  }>;
  const imageById = new Map(images.map((i) => [i.id, i]));

  const submissionIds = [...new Set(images.map((i) => i.submission_id))];
  const { data: subs } = submissionIds.length
    ? await supabaseAdmin.from("submissions").select("id, user_id").in("id", submissionIds)
    : { data: [] };
  const ownerBySubmission = new Map(
    ((subs ?? []) as Array<{ id: string; user_id: string }>).map((s) => [s.id, s.user_id]),
  );
  const ownerIds = [...new Set(ownerBySubmission.values())];
  const { data: owners } = ownerIds.length
    ? await supabaseAdmin.from("users").select("id, role, share_sale_outcomes").in("id", ownerIds)
    : { data: [] };
  const qualifies = new Map(
    ((owners ?? []) as Array<{ id: string; role: string | null; share_sale_outcomes: boolean | null }>)
      .map((o) => [o.id, ownerQualifies(o.role, o.share_sale_outcomes)]),
  );

  // Sign only what may still be shown.
  const eligibleImages = images.filter((i) => {
    const owner = ownerBySubmission.get(i.submission_id);
    return owner ? qualifies.get(owner) === true : false;
  });
  const signed = eligibleImages.length > 0 ? await signImages(eligibleImages) : new Map<string, string>();

  return rows.map((r) => {
    const img = imageById.get(r.submission_image_id);
    const owner = img ? ownerBySubmission.get(img.submission_id) : undefined;
    return {
      ...r,
      awarded_score: Number(r.awarded_score),
      image_type: img?.image_type ?? null,
      url: signed.get(r.submission_image_id) ?? null,
      still_eligible: owner ? qualifies.get(owner) === true : false,
    };
  });
}
