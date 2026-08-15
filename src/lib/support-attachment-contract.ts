// US-2561: the support-attachment contract, pinned once so iOS implements the
// protocol that exists rather than a Swift re-reading of it.
//
// US-2525 shipped attachments and a user-side close on web + edge.
// ios/GradeThread/Support/SupportTicketsView.swift sends body text only and
// offers no close, so the app is the one client where support is text-only.
// Building that needs macOS. What does NOT need macOS is writing down exactly
// what the endpoints already accept and return — every value here was read out
// of the running code, not decided here, and the guard in
// src/test/support-attachment-contract.test.ts compares each one back to its
// source so this file cannot quietly become fiction.
//
// The endpoints are UNCHANGED and no new one is needed (AC2). The whole iOS
// story is client work against this:
//
//   POST /api/support-tickets              { subject, body, attachments[] }
//   POST /api/support-tickets/:id/messages { body, attachments[] }
//   POST /api/support-tickets/:id/close    (no body)
//   GET  /api/support-tickets/:id          → messages[].attachments[].url

/**
 * Images per message. Enough for a before/after plus a screenshot.
 *
 * ⚠ THIS NUMBER ALREADY EXISTS TWICE — `MAX_ATTACHMENTS_PER_MESSAGE` in the edge
 * route (which REJECTS over the limit with a 400) and `MAX_ATTACHMENTS` in the
 * web picker (which stops you selecting more). A Swift constant would be the
 * third. They must agree or the client lets you attach something the server
 * throws away after you have waited for the upload.
 */
export const SUPPORT_MAX_ATTACHMENTS = 3;

/**
 * Signed-URL lifetime in seconds, as the GET issues them.
 *
 * This is the number AC3 hangs on. The URLs are short-lived by design — the
 * bucket is PRIVATE (US-276) and a support screenshot can contain anything — so
 * a thread left open on screen for eleven minutes has dead image URLs. The
 * client must treat that as "re-fetch the thread", never as a broken image.
 */
export const SUPPORT_ATTACHMENT_URL_TTL_SEC = 600;

/** The image formats the server accepts. Anything else is rejected by magic bytes. */
export const SUPPORT_ATTACHMENT_FORMATS = ["jpeg", "png", "webp"] as const;

/**
 * On-device downscale before upload (AC5), matching what the web picker does via
 * `compressImage`. A 12MP photo base64-encodes to several megabytes, and the
 * body is JSON, so this is the difference between a support reply and a timeout
 * on a phone signal.
 */
export const SUPPORT_ATTACHMENT_MAX_WIDTH = 2400;
export const SUPPORT_ATTACHMENT_JPEG_QUALITY = 0.85;

/**
 * One attachment as the POST bodies carry it.
 *
 * `data_url`, snake_case, NOT `dataUrl` — the edge reads `item?.data_url` and a
 * camelCase key decodes to null, which surfaces as "One attachment was not an
 * image." with no hint that the bytes were fine and the key was wrong.
 */
export interface SupportAttachmentUpload {
  data_url: string;
  name: string;
}

/** One attachment as the GET returns it. `url` is null when signing failed. */
export interface SupportAttachmentView {
  path: string;
  name: string;
  content_type: string;
  bytes: number;
  url: string | null;
}

/**
 * The exact data-URL shape the server's decoder accepts.
 *
 * Mirrors `decodeImageDataUrl` in the edge route. Two things a client gets wrong
 * here: the media type must be `image/<something>` (a bare `data:;base64,` is
 * rejected), and the encoding must be declared `;base64`.
 */
export const SUPPORT_DATA_URL_PATTERN =
  /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i;

export function isSupportDataUrl(value: string): boolean {
  return SUPPORT_DATA_URL_PATTERN.test(value);
}

/**
 * Whether a signed attachment URL is still worth putting in an image view.
 *
 * AC3 asks for a placeholder rather than a broken image, and there are TWO ways
 * to get one, which a client that only null-checks will miss:
 *
 *   • `url` is null — signing failed server-side. Permanent for this response;
 *     re-fetching may fix it.
 *   • `url` is a real string that has since EXPIRED. The response was fine when
 *     it arrived and rots in place after the TTL, so nothing about the value
 *     itself says it is dead. This is the common case: a user reads a thread,
 *     switches apps, comes back twenty minutes later.
 *
 * `fetchedAt` is when the GET that produced this URL returned. A small safety
 * margin is subtracted so a URL that is about to expire mid-request is treated
 * as already gone — better one unnecessary re-fetch than an image that fails to
 * load after the user has watched a spinner.
 */
export const SUPPORT_URL_EXPIRY_MARGIN_SEC = 30;

export function isAttachmentUrlUsable(
  url: string | null,
  fetchedAtMs: number,
  nowMs: number,
): boolean {
  if (!url) return false;
  if (!Number.isFinite(fetchedAtMs) || !Number.isFinite(nowMs)) return false;
  // A clock that went backwards is not evidence the URL is fresh.
  const ageSec = (nowMs - fetchedAtMs) / 1000;
  if (ageSec < 0) return false;
  return ageSec < SUPPORT_ATTACHMENT_URL_TTL_SEC - SUPPORT_URL_EXPIRY_MARGIN_SEC;
}

/**
 * What a ticket's status becomes when the USER replies to it.
 *
 * AC4's "replying reopens it, matching web" is a SERVER behaviour the client
 * must not duplicate — it is here so an iOS thread view knows the row it just
 * replied to is now open, without a second GET, and so nobody implements a
 * different rule in Swift.
 *
 * Note `closed` is the user's word and `resolved` is support's verdict that the
 * problem was fixed. The close endpoint writes `closed` and never `resolved`,
 * deliberately: letting a user set `resolved` would overwrite support's own
 * record of what happened.
 */
export type SupportTicketStatus = "open" | "pending" | "resolved" | "closed";

export function statusAfterUserReply(
  current: SupportTicketStatus,
): SupportTicketStatus {
  return current === "resolved" || current === "closed" ? "open" : current;
}

/** Closing is idempotent: the endpoint answers ok on a ticket already closed. */
export function statusAfterUserClose(): SupportTicketStatus {
  return "closed";
}
