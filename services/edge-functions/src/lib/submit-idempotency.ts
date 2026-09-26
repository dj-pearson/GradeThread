// US-3532: make a retried grade submit return the first submission instead of
// creating and charging a second one. The key comes from the client's
// Idempotency-Key header; 00842 stores it with a unique index per owner.

import { supabaseAdmin } from "./supabase.ts";

const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** The header value if it is a usable key, else null (the submit proceeds as before). */
export function parseIdempotencyKey(
  raw: string | undefined | null,
): string | null {
  const v = (raw ?? "").trim();
  return KEY_RE.test(v) ? v : null;
}

export interface ExistingSubmission {
  id: string;
  status: string;
}

export async function findSubmissionByKey(
  ownerId: string,
  key: string,
): Promise<ExistingSubmission | null> {
  const { data, error } = await supabaseAdmin
    .from("submissions")
    .select("id, status")
    .eq("user_id", ownerId)
    .eq("idempotency_key", key)
    .maybeSingle();
  if (error || !data) return null;
  return data as ExistingSubmission;
}

/** True when an insert lost the race to the same key. */
export function isIdempotencyConflict(
  err: { code?: string; message?: string } | null,
): boolean {
  return !!err && err.code === "23505" &&
    (err.message ?? "").includes("submissions_owner_idempotency_key");
}

/** The replay response body: the same shape as a fresh submit, marked replayed. */
export function replayBody(existing: ExistingSubmission) {
  return { submissionId: existing.id, status: existing.status, replayed: true };
}
