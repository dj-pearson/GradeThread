import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  buildDisclosure,
  type DisclosureInput,
  type PerImageAnalysisLike,
} from "../lib/disclosure.ts";

// Auto-Disclosure Engine endpoints. Everything is scoped through the OWNING
// inventory_item: we verify the caller owns the item (user_id === owner) before
// touching its grade report, photos, or listing. The grade_report is reached
// only via the owned item's grade_report_id, never by a request-supplied id
// (US-268).

export const flipdeskDisclosureRoutes = new Hono<{
  Variables: { userId: string; workspaceOwnerId: string };
}>();

// submission-images is private — short-lived signed URLs only (US-276, ≤15 min).
const SIGNED_URL_TTL = 15 * 60;

interface OwnedItem {
  id: string;
  user_id: string;
  title: string | null;
  brand: string | null;
  grade_report_id: string | null;
}

/** Load an inventory_item iff the caller owns it. Returns null otherwise. */
async function loadOwnedItem(
  itemId: string,
  ownerId: string,
): Promise<OwnedItem | null> {
  const { data } = await supabaseAdmin
    .from("inventory_items")
    .select("id, user_id, title, brand, grade_report_id")
    .eq("id", itemId)
    .eq("user_id", ownerId)
    .maybeSingle();
  return (data as OwnedItem | null) ?? null;
}

interface GradeReportRow {
  id: string;
  submission_id: string;
  overall_score: number;
  grade_tier: string;
  defects_found: unknown;
  detected_style_attributes: unknown;
  per_image_analysis: unknown;
  detailed_notes: Record<string, string> | null;
  certificate_id: string | null;
}

function toDisclosureInput(report: GradeReportRow): DisclosureInput {
  return {
    overall_score: report.overall_score,
    grade_tier: report.grade_tier,
    defects_found: Array.isArray(report.defects_found)
      ? (report.defects_found as DisclosureInput["defects_found"])
      : [],
    detected_style_attributes: Array.isArray(report.detected_style_attributes)
      ? (report.detected_style_attributes as DisclosureInput["detected_style_attributes"])
      : [],
    per_image_analysis: Array.isArray(report.per_image_analysis)
      ? (report.per_image_analysis as PerImageAnalysisLike[])
      : [],
    certificate_id: report.certificate_id,
    legacy_defects_summary: report.detailed_notes?.defects_summary ?? null,
  };
}

// ── GET /item/:itemId ─────────────────────────────────────────────
// The disclosure + signed defect-photo URLs + per-photo annotation data.
flipdeskDisclosureRoutes.get("/item/:itemId", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const itemId = c.req.param("itemId");

  const item = await loadOwnedItem(itemId, ownerId);
  if (!item) return c.json({ error: "Item not found" }, 404);
  if (!item.grade_report_id) {
    return c.json({ graded: false, item: { id: item.id, title: item.title } });
  }

  const { data: reportRaw, error: reportErr } = await supabaseAdmin
    .from("grade_reports")
    .select(
      "id, submission_id, overall_score, grade_tier, defects_found, detected_style_attributes, per_image_analysis, detailed_notes, certificate_id",
    )
    .eq("id", item.grade_report_id)
    .maybeSingle();
  if (reportErr) return c.json({ error: reportErr.message }, 500);
  if (!reportRaw) {
    return c.json({ graded: false, item: { id: item.id, title: item.title } });
  }
  const report = reportRaw as GradeReportRow;

  const disclosure = buildDisclosure(toDisclosureInput(report));

  // Sign the submission images so the canvas can draw callouts on them.
  const { data: images } = await supabaseAdmin
    .from("submission_images")
    .select("image_type, storage_path, display_order")
    .eq("submission_id", report.submission_id)
    .order("display_order", { ascending: true });

  const urlByType = new Map<string, string>();
  for (const img of images ?? []) {
    const path = (img as { storage_path: string | null }).storage_path;
    const type = (img as { image_type: string }).image_type;
    if (!path || urlByType.has(type)) continue;
    const { data: signed } = await supabaseAdmin.storage
      .from("submission-images")
      .createSignedUrl(path, SIGNED_URL_TTL);
    if (signed?.signedUrl) urlByType.set(type, signed.signedUrl);
  }

  // Join annotation data to a usable photo URL. Drop annotation groups whose
  // source image we couldn't resolve.
  const photos = disclosure.image_annotations
    .map((ia) => ({
      image_type: ia.image_type,
      url: urlByType.get(ia.image_type) ?? null,
      annotations: ia.annotations,
    }))
    .filter((p) => p.url !== null);

  return c.json({
    graded: true,
    item: { id: item.id, title: item.title, brand: item.brand },
    grade: {
      overall_score: report.overall_score,
      grade_tier: report.grade_tier,
      certificate_id: report.certificate_id,
    },
    disclosure: {
      plain: disclosure.plain,
      markdown: disclosure.markdown,
      html: disclosure.html,
      defect_count: disclosure.defect_count,
      has_defects: disclosure.has_defects,
      style_features: disclosure.style_features,
    },
    photos,
  });
});

// ── POST /item/:itemId/apply-to-listing ───────────────────────────
// Append the disclosure HTML to the item's draft eBay listing's condition
// description. Idempotent: a marker prevents double-appends.
const DISCLOSURE_MARKER = "<!--gradethread-disclosure-->";

flipdeskDisclosureRoutes.post("/item/:itemId/apply-to-listing", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const itemId = c.req.param("itemId");

  const item = await loadOwnedItem(itemId, ownerId);
  if (!item) return c.json({ error: "Item not found" }, 404);
  if (!item.grade_report_id) return c.json({ error: "Item is not graded" }, 400);

  const { data: report } = await supabaseAdmin
    .from("grade_reports")
    .select(
      "id, submission_id, overall_score, grade_tier, defects_found, detected_style_attributes, per_image_analysis, detailed_notes, certificate_id",
    )
    .eq("id", item.grade_report_id)
    .maybeSingle();
  if (!report) return c.json({ error: "Grade report not found" }, 404);

  const disclosure = buildDisclosure(toDisclosureInput(report as GradeReportRow));

  // Most recent eBay listing/draft for this owned item. The rich HTML
  // disclosure goes into the listing BODY (description) — eBay's separate
  // ConditionDescription field is plain-text + length-capped. We also seed the
  // plain disclosure into ebay_condition_description when it's empty.
  const { data: listing } = await supabaseAdmin
    .from("listings")
    .select("id, listing_description, ebay_condition_description")
    .eq("inventory_item_id", item.id)
    .eq("platform", "ebay")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!listing) {
    return c.json({ error: "No eBay listing/draft for this item yet." }, 404);
  }

  const listingId = (listing as { id: string }).id;
  const body = (listing as { listing_description: string | null }).listing_description ?? "";
  if (body.includes(DISCLOSURE_MARKER)) {
    return c.json({ applied: true, already_present: true, listing_id: listingId });
  }

  const block = `${DISCLOSURE_MARKER}${disclosure.html}`;
  const update: Record<string, unknown> = {
    listing_description: body.trim() ? `${body}\n${block}` : block,
  };
  // Seed the plain disclosure into the condition field if the seller hasn't set
  // one (eBay caps it ~1000 chars).
  const cond = (listing as { ebay_condition_description: string | null }).ebay_condition_description;
  if (!cond || !cond.trim()) {
    update.ebay_condition_description = disclosure.plain.slice(0, 990);
  }

  const { error: updErr } = await supabaseAdmin
    .from("listings")
    .update(update)
    .eq("id", listingId);
  if (updErr) return c.json({ error: updErr.message }, 500);

  return c.json({ applied: true, listing_id: listingId });
});

// ── POST /item/:itemId/annotated-photo ────────────────────────────
// Persist a client-rendered annotated defect photo (base64 PNG data URL) as a
// new item_photos row so it can be included in the listing's photo set.
interface AnnotatedPhotoBody {
  image_type?: string;
  data_url?: string;
}

flipdeskDisclosureRoutes.post("/item/:itemId/annotated-photo", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const itemId = c.req.param("itemId");

  const item = await loadOwnedItem(itemId, ownerId);
  if (!item) return c.json({ error: "Item not found" }, 404);

  let body: AnnotatedPhotoBody;
  try {
    body = (await c.req.json()) as AnnotatedPhotoBody;
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  const match = (body.data_url ?? "").match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    return c.json({ error: "data_url must be a base64 image/png data URL." }, 400);
  }
  const bytes = Uint8Array.from(atob(match[1]), (ch) => ch.charCodeAt(0));
  // Guard against absurd payloads (canvas PNGs are typically < 2MB).
  if (bytes.byteLength > 8 * 1024 * 1024) {
    return c.json({ error: "Annotated image is too large." }, 413);
  }

  const safeType = (body.image_type ?? "defect").replace(/[^a-z0-9_-]/gi, "");
  const path = `${ownerId}/${item.id}/disclosure_${safeType}_${Date.now()}.png`;
  const { error: upErr } = await supabaseAdmin.storage
    .from("item-photos")
    .upload(path, bytes, { contentType: "image/png", upsert: false });
  if (upErr) return c.json({ error: "Failed to store annotated photo." }, 500);

  const { data: pub } = supabaseAdmin.storage.from("item-photos").getPublicUrl(path);

  const { data: maxSort } = await supabaseAdmin
    .from("item_photos")
    .select("sort_order")
    .eq("inventory_item_id", item.id)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextSort =
    typeof (maxSort as { sort_order?: number } | null)?.sort_order === "number"
      ? ((maxSort as { sort_order: number }).sort_order ?? 0) + 1
      : 0;

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("item_photos")
    .insert({
      inventory_item_id: item.id,
      photo_url: pub.publicUrl,
      storage_path: path,
      photo_type: "defect",
      sort_order: nextSort,
      bytes: bytes.byteLength,
    })
    .select("id")
    .maybeSingle();
  if (insErr) return c.json({ error: "Failed to record annotated photo." }, 500);

  return c.json({
    ok: true,
    photo_id: (inserted as { id?: string } | null)?.id ?? null,
    photo_url: pub.publicUrl,
  });
});
