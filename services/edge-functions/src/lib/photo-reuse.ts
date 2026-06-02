import { supabaseAdmin } from "./supabase.ts";

// Photo-reuse detection (US-337).
//
// Each grading photo carries a client-computed 64-bit dHash (16 hex chars). The
// same photo reused across submissions hashes to a near-identical value even
// after our resize/recompression, so a small Hamming distance between two
// hashes means "same image". A match to a DIFFERENT account is the strong
// signal of a stolen/recycled listing or stock photo — we route those to
// moderation. A match to the SAME account is just a relist (informational).

// Near-duplicate threshold (bits out of 64). dHash near-dupes typically sit
// well under 10; tunable per-deploy.
export const REUSE_MAX_HAMMING_DEFAULT = 10;
// Bounded candidate scan — a full-scan Hamming over recent hashed rows is fine
// at launch scale and avoids needing a specialized index.
const CANDIDATE_LIMIT = 5000;
const HEX16 = /^[0-9a-f]{16}$/i;

function maxHamming(): number {
  const raw = Number(Deno.env.get("GRADING_REUSE_MAX_HAMMING"));
  return Number.isFinite(raw) && raw >= 0 && raw <= 64 ? raw : REUSE_MAX_HAMMING_DEFAULT;
}

/**
 * Hamming distance (differing bits) between two 16-hex-char (64-bit) dHashes.
 * Returns 64 (max distance → "no match") for malformed or unequal inputs, so
 * bad data can never produce a false positive. Pure — unit-tested.
 */
export function hammingHex(a: string, b: string): number {
  if (!HEX16.test(a) || !HEX16.test(b)) return 64;
  let dist = 0;
  for (let i = 0; i < 16; i++) {
    let x = (parseInt(a[i], 16) ^ parseInt(b[i], 16)) & 0xf;
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}

export interface PhotoReuseMatch {
  image_type: string; // which of THIS submission's images matched
  matched_submission_id: string;
  matched_image_id: string;
  distance: number;
}

export interface PhotoReuseResult {
  matched: boolean;
  // At least one match belongs to a DIFFERENT account (the fraud-relevant case).
  cross_user: boolean;
  matches: PhotoReuseMatch[];
  summary: string;
}

const EMPTY: PhotoReuseResult = { matched: false, cross_user: false, matches: [], summary: "" };

/**
 * Detect whether this submission's photos reuse images from other submissions.
 * Scans recent hashed rows and reports the closest match per image within the
 * threshold. Never throws — a DB hiccup returns "no match".
 */
export async function detectPhotoReuse(opts: {
  submissionId: string;
  ownerId: string;
  images: Array<{ image_type: string; phash: string | null }>;
}): Promise<PhotoReuseResult> {
  try {
    const threshold = maxHamming();
    const mine = opts.images.filter(
      (i): i is { image_type: string; phash: string } =>
        typeof i.phash === "string" && HEX16.test(i.phash),
    );
    if (mine.length === 0) return EMPTY;

    const { data: candidates, error } = await supabaseAdmin
      .from("submission_images")
      .select("id, submission_id, phash")
      .not("phash", "is", null)
      .neq("submission_id", opts.submissionId)
      .order("created_at", { ascending: false })
      .limit(CANDIDATE_LIMIT);
    if (error || !candidates || candidates.length === 0) return EMPTY;

    // Resolve owners so we can tell a cross-account reuse from a self-relist.
    const subIds = [...new Set(candidates.map((c) => c.submission_id as string))];
    const { data: subs } = await supabaseAdmin
      .from("submissions")
      .select("id, user_id")
      .in("id", subIds);
    const ownerBySub = new Map<string, string>();
    for (const s of subs ?? []) ownerBySub.set(s.id as string, s.user_id as string);

    const matches: PhotoReuseMatch[] = [];
    let crossUser = false;

    for (const m of mine) {
      let best: PhotoReuseMatch | null = null;
      for (const cand of candidates) {
        const d = hammingHex(m.phash, String(cand.phash));
        if (d <= threshold && (!best || d < best.distance)) {
          best = {
            image_type: m.image_type,
            matched_submission_id: cand.submission_id as string,
            matched_image_id: cand.id as string,
            distance: d,
          };
        }
      }
      if (best) {
        matches.push(best);
        if (ownerBySub.get(best.matched_submission_id) !== opts.ownerId) crossUser = true;
      }
    }

    if (matches.length === 0) return EMPTY;
    const n = matches.length;
    const summary = crossUser
      ? `${n} photo${n > 1 ? "s" : ""} match an image previously submitted by a different account — possible reused or stolen listing photos.`
      : `${n} photo${n > 1 ? "s" : ""} match an image from a previous submission on this account.`;
    return { matched: true, cross_user: crossUser, matches, summary };
  } catch (err) {
    console.error(
      "[photo-reuse] detection failed:",
      err instanceof Error ? err.message : String(err),
    );
    return EMPTY;
  }
}
