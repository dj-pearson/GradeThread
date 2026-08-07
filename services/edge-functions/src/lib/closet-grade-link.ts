// US-1841: write a finished grade back onto the buyer's closet item.
//
// A buyer who asks for a walk-around grade asks about ONE garment in their
// portfolio. Leaving the answer only in a submissions list would make them go
// find it, and the portfolio would keep showing whatever condition they typed in
// when they added the item — a number the grade has just superseded.
//
// Best-effort by construction: this runs after the grade report is already
// written and committed, so nothing here may throw or the pipeline would fail a
// grade the buyer has already paid for over a portfolio nicety.

import { supabaseAdmin } from "./supabase.ts";

export interface ClosetGradeLink {
  closetItemId: string;
  /** The closet item's owner — closet_items are personal, so this scopes the write. */
  ownerUserId: string;
  certificateId: string | null;
  overallScore: number;
}

/**
 * Stamp the graded condition (and the certificate, when there is one) onto the
 * buyer's closet item.
 *
 * TENANT ISOLATION (US-268): scoped by `user_id` as well as `id`, so a
 * closet_item_id that somehow reached a submission belonging to another account
 * updates zero rows instead of writing across tenants.
 *
 * The certificate write is attempted SEPARATELY and second, because
 * `uq_closet_cert` (00420) makes (user_id, certificate_id) unique: a buyer who
 * had already closeted this certificate by hand would otherwise lose the grade
 * update too, to a conflict that only affects the link. The grade is the part
 * they asked for; the link is a convenience.
 */
export async function writeGradeToClosetItem(link: ClosetGradeLink): Promise<void> {
  const { error: gradeError } = await supabaseAdmin
    .from("closet_items")
    .update({ condition_grade: link.overallScore })
    .eq("id", link.closetItemId)
    .eq("user_id", link.ownerUserId);
  if (gradeError) {
    console.error("[closet-grade-link] grade write-back failed:", gradeError.message);
    return;
  }

  if (!link.certificateId) return;
  const { error: certError } = await supabaseAdmin
    .from("closet_items")
    .update({ certificate_id: link.certificateId })
    .eq("id", link.closetItemId)
    .eq("user_id", link.ownerUserId)
    // Only fill an EMPTY link: a closet item already pointing at a certificate
    // was linked deliberately, and silently repointing it would rewrite the
    // buyer's own record of what this garment is.
    .is("certificate_id", null);
  if (certError) {
    console.error("[closet-grade-link] certificate link failed:", certError.message);
  }
}
