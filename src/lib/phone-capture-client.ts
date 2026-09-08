// US-3161: the two halves of a phone capture, as rules rather than components.
//
// The DESKTOP half mints a code and watches. The PHONE half sends one photo at
// a time and is not signed in to anything. Both live here so the awkward parts
// are testable without a camera: what a refusal means, what a retry must not
// do twice, and what the phone is allowed to know.

export interface CaptureStartResult {
  sessionId: string;
  /** The URL to put in the QR. Carries the token and nothing else. */
  url: string;
  expiresAt: string;
  maxPhotos: number;
}

export interface CapturePhoto {
  id: string;
  url: string;
  storagePath: string;
  width: number | null;
  height: number | null;
  bytes: number;
}

export interface CaptureStatus {
  sessionId: string;
  expiresAt: string;
  endedAt: string | null;
  live: boolean;
  photoCount: number;
  photos: CapturePhoto[];
}

/** What the phone page renders itself from. Nothing here names the seller. */
export interface CapturePublicState {
  live: boolean;
  photosTaken: number;
  photosLeft: number;
  expiresAt: string;
  targetKind: "item" | "batch";
}

export interface CaptureFetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export type CaptureFetch = (
  path: string,
  init?: { method?: string; json?: unknown; body?: FormData; unauthenticated?: boolean },
) => Promise<CaptureFetchResponse>;

function messageFrom(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
    return (body as { error: string }).error;
  }
  return fallback;
}

// ── Desktop ─────────────────────────────────────────────────────────

export async function startCapture(
  fetchEdge: CaptureFetch,
  targetKind: "item" | "batch",
  targetId: string,
): Promise<CaptureStartResult> {
  const res = await fetchEdge("/api/flipdesk/capture/sessions", {
    method: "POST",
    json: { targetKind, targetId },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(messageFrom(body, "Could not start the phone camera."));
  return body as CaptureStartResult;
}

export async function readCaptureStatus(
  fetchEdge: CaptureFetch,
  sessionId: string,
): Promise<CaptureStatus> {
  const res = await fetchEdge(`/api/flipdesk/capture/sessions/${sessionId}`);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(messageFrom(body, "Could not check the phone camera."));
  return body as CaptureStatus;
}

export async function endCapture(
  fetchEdge: CaptureFetch,
  sessionId: string,
): Promise<void> {
  await fetchEdge(`/api/flipdesk/capture/sessions/${sessionId}/end`, { method: "POST" });
}

// ── Phone ───────────────────────────────────────────────────────────

/**
 * Read the session behind a scanned token.
 *
 * A dead code is NOT an exception here. Expired, finished and never-existed are
 * all ordinary things for this page to render, and throwing would put a stack
 * trace where a sentence belongs.
 */
export async function readCapturePublic(
  fetchEdge: CaptureFetch,
  token: string,
): Promise<{ ok: true; state: CapturePublicState } | { ok: false; reason: string }> {
  const res = await fetchEdge(`/api/flipdesk/capture/s/${encodeURIComponent(token)}`, {
    unauthenticated: true,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    return { ok: false, reason: messageFrom(body, "This code is no longer good.") };
  }
  return { ok: true, state: body as CapturePublicState };
}

export interface CaptureSendResult {
  ok: boolean;
  /** True when the server recognised this as a retry of one that already landed. */
  duplicate: boolean;
  photosTaken: number | null;
  photosLeft: number | null;
  /** Set when the send failed. Shown as-is; the server writes for a person. */
  error: string | null;
  /** True when the code itself is finished, so the page should stop offering to send. */
  gone: boolean;
}

/**
 * Send one photo.
 *
 * `clientKey` is what makes a retry safe: the server keys on it, so a photo
 * that actually landed before the connection dropped is recognised rather than
 * added twice and counted twice against the session's caps.
 */
export async function sendCapturePhoto(
  fetchEdge: CaptureFetch,
  token: string,
  file: File,
  clientKey: string,
): Promise<CaptureSendResult> {
  const form = new FormData();
  form.append("photo", file);
  form.append("clientKey", clientKey);

  const res = await fetchEdge(`/api/flipdesk/capture/s/${encodeURIComponent(token)}/photos`, {
    method: "POST",
    body: form,
    unauthenticated: true,
  });
  const body = await res.json().catch(() => null) as
    | { duplicate?: boolean; photosTaken?: number; photosLeft?: number; error?: string }
    | null;

  if (!res.ok) {
    return {
      ok: false,
      duplicate: false,
      photosTaken: null,
      photosLeft: null,
      error: messageFrom(body, "That photo did not send."),
      // 410 means the code is finished for good; 429 means it is full. Both end
      // the session for this page, and neither is worth retrying.
      gone: res.status === 410 || res.status === 429 || res.status === 404,
    };
  }
  return {
    ok: true,
    duplicate: body?.duplicate === true,
    photosTaken: typeof body?.photosTaken === "number" ? body.photosTaken : null,
    photosLeft: typeof body?.photosLeft === "number" ? body.photosLeft : null,
    error: null,
    gone: false,
  };
}

/** A key for one shot, stable across a retry of the same file. */
export function captureClientKey(): string {
  return crypto.randomUUID();
}

/** Minutes and seconds left, or null once the code is past its time. */
export function timeLeft(expiresAt: string, now: number = Date.now()): string | null {
  const ms = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.floor(ms / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}
