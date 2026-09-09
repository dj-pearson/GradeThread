// US-3161: phone as camera. Scan a code on the computer, shoot on the phone,
// the photos land on the item.
//
// Mounted at /api/flipdesk/capture. TWO HALVES with completely different trust:
//
//   • /sessions*  — ordinary authed routes. The seller starts a session, watches
//     it fill and ends it. Every query is scoped to workspaceOwnerId ?? userId,
//     and the target is ownership-checked BEFORE a token is minted, because a
//     token bound to somebody else's item would be a capture code that uploads
//     into their catalogue (US-268).
//
//   • /s/:token*  — PUBLIC. No session, no cookie, no login. The scanned token
//     is the entire credential, which is the point: the fast version of this has
//     no app install and no password typed on a phone while holding a jumper.
//     So the token is looked up BY HASH, it reaches exactly one session, and
//     every limit — target, expiry, photo count, bytes — is enforced here rather
//     than by a page that can be edited. The phone is never told whose item it
//     is, nor anything else about the seller.
//
// A refused upload answers 410 GONE for an expired or finished code and 429 for
// a full one. Both are deliberate: 410 tells the person holding the phone to
// scan a new code, which is what they should do, where a 403 would read as "you
// are not allowed" and send them looking for a login that does not exist.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { validateImageUpload } from "../lib/upload-validation.ts";
import { stripImageMetadata } from "../lib/image-metadata.ts";
import { itemPhotoStaging } from "../lib/photo-staging-storage.ts";
import {
  CAPTURE_MAX_PHOTO_BYTES,
  CAPTURE_MAX_PHOTOS,
  CAPTURE_TTL_MS,
  type CaptureSessionState,
  hashCaptureToken,
  isCaptureTargetKind,
  isWellFormedCaptureToken,
  newCaptureToken,
  missingPhotoTypes,
  publicView,
  refuseCapture,
} from "../lib/phone-capture.ts";
import { REQUIRED_GRADING_PHOTO_TYPES } from "../lib/grading-submit.ts";

type CaptureEnv = {
  Variables: {
    userId: string;
    workspaceOwnerId: string;
    workspaceRole: "viewer" | "member" | "listing_manager" | "admin" | "owner";
  };
};

export const flipdeskPhoneCaptureRoutes = new Hono<CaptureEnv>();

const SESSION_COLUMNS =
  "id, owner_user_id, started_by_user_id, target_kind, target_id, expires_at, ended_at, photo_count, bytes_total";

function appUrl(path: string): string {
  const base = Deno.env.get("APP_URL")?.replace(/\/$/, "") ?? "https://gradethread.com";
  return `${base}${path}`;
}

interface SessionRow extends CaptureSessionState {
  id: string;
  owner_user_id: string;
  started_by_user_id: string;
  target_kind: string;
  target_id: string;
}

/**
 * Does this tenant own the thing the capture would write to?
 *
 * Called BEFORE a token exists. Skipping it would let a caller mint a code that
 * uploads into another seller's item — the id comes from the request body, so
 * this is exactly the shape US-268 is about.
 */
async function ownsTarget(
  ownerId: string,
  kind: string,
  id: string,
): Promise<boolean> {
  const table = kind === "batch" ? "listing_generation_batches" : "inventory_items";
  const { data } = await supabaseAdmin
    .from(table)
    .select("id")
    .eq("id", id)
    .eq("user_id", ownerId)
    .maybeSingle();
  return !!data;
}

// ── POST /sessions ──────────────────────────────────────────────────
// Mint a code for one item or one batch.
flipdeskPhoneCaptureRoutes.post("/sessions", async (c) => {
  const userId = c.get("userId");
  const ownerId = c.get("workspaceOwnerId") ?? userId;

  const body = await c.req.json().catch(() => null) as
    | { targetKind?: unknown; targetId?: unknown }
    | null;
  const kind = body?.targetKind;
  const targetId = body?.targetId;
  if (!isCaptureTargetKind(kind) || typeof targetId !== "string" || !targetId) {
    return c.json({ error: "A capture needs an item or a batch to write to." }, 400);
  }
  if (!await ownsTarget(ownerId, kind, targetId)) {
    // 404 rather than 403: a caller who does not own it should not learn
    // whether the id exists at all.
    return c.json({ error: "That item could not be found." }, 404);
  }

  const token = newCaptureToken();
  const { data, error } = await supabaseAdmin
    .from("phone_capture_sessions")
    .insert({
      token_hash: await hashCaptureToken(token),
      owner_user_id: ownerId,
      started_by_user_id: userId,
      target_kind: kind,
      target_id: targetId,
      expires_at: new Date(Date.now() + CAPTURE_TTL_MS).toISOString(),
    })
    .select("id, expires_at")
    .single();
  if (error || !data) {
    console.error("[capture] session create failed:", error?.message);
    return c.json({ error: "Could not start the phone camera." }, 500);
  }

  const row = data as { id: string; expires_at: string };
  return c.json({
    sessionId: row.id,
    expiresAt: row.expires_at,
    // The token is returned exactly ONCE, to the page that will draw the QR.
    // Only its hash is stored, so it cannot be handed out again.
    url: appUrl(`/capture/${token}`),
    maxPhotos: CAPTURE_MAX_PHOTOS,
  });
});

// ── GET /sessions/:id ───────────────────────────────────────────────
// What the desktop polls: has anything arrived, and is the code still live.
flipdeskPhoneCaptureRoutes.get("/sessions/:id", async (c) => {
  const userId = c.get("userId");
  const ownerId = c.get("workspaceOwnerId") ?? userId;

  const { data } = await supabaseAdmin
    .from("phone_capture_sessions")
    .select(SESSION_COLUMNS)
    .eq("id", c.req.param("id"))
    .eq("owner_user_id", ownerId)
    .maybeSingle();
  const session = data as SessionRow | null;
  if (!session) return c.json({ error: "That capture could not be found." }, 404);

  const { data: photoRows } = await supabaseAdmin
    .from("phone_capture_photos")
    .select("id, public_url, storage_path, width, height, bytes, created_at")
    .eq("session_id", session.id)
    .order("created_at", { ascending: true });

  return c.json({
    sessionId: session.id,
    expiresAt: session.expires_at,
    endedAt: session.ended_at,
    live: !session.ended_at && new Date(session.expires_at).getTime() > Date.now(),
    photoCount: session.photo_count,
    photos: (photoRows ?? []).map((p) => {
      const row = p as {
        id: string;
        public_url: string;
        storage_path: string;
        width: number | null;
        height: number | null;
        bytes: number;
      };
      return {
        id: row.id,
        url: row.public_url,
        storagePath: row.storage_path,
        width: row.width,
        height: row.height,
        bytes: row.bytes,
      };
    }),
  });
});

// ── POST /sessions/:id/end ──────────────────────────────────────────
flipdeskPhoneCaptureRoutes.post("/sessions/:id/end", async (c) => {
  const userId = c.get("userId");
  const ownerId = c.get("workspaceOwnerId") ?? userId;

  const { data, error } = await supabaseAdmin
    .from("phone_capture_sessions")
    .update({ ended_at: new Date().toISOString() })
    .eq("id", c.req.param("id"))
    .eq("owner_user_id", ownerId)
    .is("ended_at", null)
    .select("id")
    .maybeSingle();
  if (error) return c.json({ error: "Could not end the capture." }, 500);
  // Already ended is a success: the seller asked for it to be over and it is.
  return c.json({ ok: true, changed: !!data });
});

// ── PUBLIC: the phone's half ────────────────────────────────────────

/** Resolve a token to its session, or say why not. Never leaks the seller. */
async function sessionForToken(
  raw: string | undefined,
): Promise<{ ok: true; session: SessionRow } | { ok: false; status: 404 | 410; error: string }> {
  if (!isWellFormedCaptureToken(raw)) {
    return { ok: false, status: 404, error: "That code is not one of ours." };
  }
  const { data } = await supabaseAdmin
    .from("phone_capture_sessions")
    .select(SESSION_COLUMNS)
    .eq("token_hash", await hashCaptureToken(raw))
    .maybeSingle();
  const session = data as SessionRow | null;
  if (!session) {
    return { ok: false, status: 404, error: "That code is not one of ours." };
  }
  return { ok: true, session };
}

/**
 * US-3162: the required shots this item still has none of.
 *
 * A photo type is a fixed vocabulary word every seller shares, so this tells
 * the phone what to shoot next without telling it whose item it is. The
 * required set is the GRADING gate's, so the prompt and the thing that will
 * later refuse a submission cannot disagree.
 */
async function missingForTarget(session: SessionRow): Promise<string[]> {
  if (session.target_kind !== "item") return [];
  // The column is inventory_item_id. It was `item_id` for the life of this
  // route, which does not exist on item_photos, so PostgREST answered 42703
  // and the whole query failed EVERY time. The error was discarded, `data`
  // came back null, and `present` was therefore always empty — so the phone
  // was told every required shot was still missing no matter how many had
  // landed. The prompt this function exists to drive never once updated.
  const { data, error } = await supabaseAdmin
    .from("item_photos")
    .select("photo_type")
    .eq("inventory_item_id", session.target_id);
  // And a FAILED read is not "this item has no photos". Answering [] here is
  // what turned a broken query into a plausible-looking wrong answer for so
  // long; the caller decides what to say instead.
  if (error) throw new Error(`item_photos read failed: ${error.message}`);
  const present = (data ?? []).map((r) => String((r as { photo_type: string }).photo_type ?? ""));
  return missingPhotoTypes(REQUIRED_GRADING_PHOTO_TYPES, present);
}

// GET /s/:token — what the phone page renders itself from.
flipdeskPhoneCaptureRoutes.get("/s/:token", async (c) => {
  const found = await sessionForToken(c.req.param("token"));
  if (!found.ok) return c.json({ error: found.error }, found.status);

  const refusal = refuseCapture(found.session, 0);
  if (refusal) return c.json({ error: refusal.error, live: false }, refusal.status);

  let missing: string[];
  try {
    missing = await missingForTarget(found.session);
  } catch {
    // The page is rendered from this response, and a made-up shot list is
    // worse than a retry: it would send the seller round the item shooting
    // photos it already has.
    return c.json({ error: "Could not load this capture session." }, 500);
  }

  return c.json({
    live: true,
    ...publicView(found.session, missing),
  });
});

// POST /s/:token/photos — one photo, multipart, from a phone camera.
flipdeskPhoneCaptureRoutes.post("/s/:token/photos", async (c) => {
  const found = await sessionForToken(c.req.param("token"));
  if (!found.ok) return c.json({ error: found.error }, found.status);
  const session = found.session;

  let form: Record<string, unknown>;
  try {
    form = await c.req.parseBody();
  } catch {
    return c.json({ error: "That photo did not arrive in one piece." }, 400);
  }
  const file = form["photo"];
  if (!(file instanceof File)) {
    return c.json({ error: "No photo was attached." }, 400);
  }
  const clientKey = typeof form["clientKey"] === "string" ? form["clientKey"] : null;

  // A retry of an upload that actually landed must not add a second photo or
  // count twice against the caps. The unique index does the deciding.
  if (clientKey) {
    const { data: existing } = await supabaseAdmin
      .from("phone_capture_photos")
      .select("id, public_url")
      .eq("session_id", session.id)
      .eq("client_key", clientKey)
      .maybeSingle();
    if (existing) {
      const row = existing as { id: string; public_url: string };
      return c.json({ ok: true, duplicate: true, id: row.id, url: row.public_url });
    }
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const refusal = refuseCapture(session, bytes.length);
  if (refusal) return c.json({ error: refusal.error }, refusal.status);

  // The same US-276 sequence every other upload goes through. A phone camera is
  // not a trusted source just because a seller is holding it.
  const valid = validateImageUpload(bytes, {
    allow: ["jpeg", "png", "webp"],
    maxBytes: CAPTURE_MAX_PHOTO_BYTES,
  });
  if (!valid.ok) return c.json({ error: "That file is not a photo we can read." }, 400);

  const clean = stripImageMetadata(bytes, valid.format);
  // Under the OWNER's folder, because that is what the per-user-folder storage
  // RLS reads — not the phone's, which belongs to nobody.
  const path = `${session.owner_user_id}/_staging/phone/${crypto.randomUUID()}.${valid.ext}`;
  const storage = itemPhotoStaging();
  const { error: upErr } = await storage.upload(path, clean.bytes, valid.contentType);
  if (upErr) {
    console.error("[capture] upload failed:", upErr.message);
    return c.json({ error: "That photo could not be saved. Try it again." }, 502);
  }
  const url = storage.publicUrl(path);

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("phone_capture_photos")
    .insert({
      session_id: session.id,
      storage_path: path,
      public_url: url,
      width: valid.width,
      height: valid.height,
      bytes: clean.bytes.length,
      client_key: clientKey,
    })
    .select("id")
    .single();
  if (insErr || !inserted) {
    // A duplicate here means two retries raced; the unique index is the
    // authority and the first one already counted.
    return c.json({ ok: true, duplicate: true, url });
  }

  // Counters are the caps, so they move in the same breath as the row.
  await supabaseAdmin
    .from("phone_capture_sessions")
    .update({
      photo_count: session.photo_count + 1,
      bytes_total: session.bytes_total + clean.bytes.length,
    })
    .eq("id", session.id);

  return c.json({
    ok: true,
    id: (inserted as { id: string }).id,
    url,
    photosTaken: session.photo_count + 1,
    photosLeft: Math.max(0, CAPTURE_MAX_PHOTOS - (session.photo_count + 1)),
    // US-3162: recomputed here so the phone's "still need a back shot" updates
    // as shots land, without a second round trip after every photo. It reflects
    // what the DESKTOP has tagged so far, which is the honest answer — the
    // phone does not decide what a shot is.
    //
    // Omitted rather than guessed if that read fails: the photo above DID
    // save, so this is not a failed upload, and the phone keeps the list it
    // already had instead of being handed a wrong one.
    missingTypes: await missingForTarget(session).catch(() => undefined),
  });
});
