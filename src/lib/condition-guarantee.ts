// A15: guarantee text for ONE item, only when that item qualifies.
//
// The Return reduction tab used to offer one static "graded 8.5-10.0" blurb
// that could be pasted onto any listing, including an ungraded one or one
// graded 6.0, and it promised "a full refund" on behalf of a seller whose
// return policy the app does not know. This builds the text per item: it
// quotes that item's own grade and certificate, and it refuses an item below
// the tier or without a real certificate.

import { supabase } from "@/lib/supabase";
import { certificateUrl, parseCertificateRef } from "@/lib/verified";

/** The grade a guarantee is offered from. Matches the "high" return band. */
export const GUARANTEE_MIN_GRADE = 8.5;

/** Statuses that are no longer on the rack, so there is no listing to paste into. */
const REALIZED = "(sold,shipped,completed,archived)";

export interface GuaranteeCandidate {
  id: string;
  title: string | null;
  grade_value: number | null;
  certificate_url: string | null;
}

/** The seller's all-time record at the tier, when it is large enough to quote. */
export interface GuaranteeRecord {
  sold: number;
  /** 0..1 share of those sales that shipped without a return. */
  keptRate: number;
}

/** The canonical certificate URL for an item, or null if it has no real one. */
export function guaranteeCertificateUrl(item: GuaranteeCandidate): string | null {
  const id = item.certificate_url ? parseCertificateRef(item.certificate_url) : null;
  return id ? certificateUrl(id) : null;
}

export function qualifiesForGuarantee(item: GuaranteeCandidate): boolean {
  return (
    item.grade_value != null &&
    Number.isFinite(item.grade_value) &&
    item.grade_value >= GUARANTEE_MIN_GRADE &&
    item.grade_value <= 10 &&
    guaranteeCertificateUrl(item) != null
  );
}

/**
 * The text a seller pastes into this item's listing, or null when the item
 * does not qualify. The track-record sentence is added only when a record is
 * passed in; the caller decides whether that record is large enough.
 */
export function buildGuaranteeText(
  item: GuaranteeCandidate,
  record: GuaranteeRecord | null,
): string | null {
  if (!qualifiesForGuarantee(item)) return null;
  const cert = guaranteeCertificateUrl(item)!;
  const grade = item.grade_value!.toFixed(1);
  const parts = [
    `Condition guarantee: this item is independently graded ${grade} out of 10. Certificate: ${cert}`,
  ];
  if (record && record.sold > 0) {
    parts.push(
      `Across my ${record.sold} sales graded ${GUARANTEE_MIN_GRADE.toFixed(1)} or higher, ${Math.round(
        record.keptRate * 100,
      )}% shipped with no return.`,
    );
  }
  parts.push(
    "If it arrives in worse condition than the certificate states, see my return policy.",
  );
  return parts.join(" ");
}

/**
 * The tenant's unsold items that qualify, best grade first, plus the total.
 * RLS scopes the read; the owner filter keeps a workspace member on the
 * workspace's stock rather than their own.
 */
export async function fetchGuaranteeCandidates(
  ownerId: string,
  limit = 5,
): Promise<{ items: GuaranteeCandidate[]; total: number }> {
  const { data, error, count } = await supabase
    .from("inventory_items")
    .select("id, title, grade_value, certificate_url", { count: "exact" })
    .eq("user_id", ownerId)
    .gte("grade_value", GUARANTEE_MIN_GRADE)
    .not("certificate_url", "is", null)
    .not("status", "in", REALIZED)
    .order("grade_value", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const items = ((data ?? []) as GuaranteeCandidate[]).filter(qualifiesForGuarantee);
  return { items, total: count ?? items.length };
}
