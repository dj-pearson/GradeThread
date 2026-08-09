import { edgeFetch } from "./edge-fetch";

// US-2228 AC2 — the browser half of expense receipts.
//
// These go through the edge rather than supabase-js on purpose. The bucket is
// private with no storage policies, and the bytes have to be sniffed by magic
// number and stripped of EXIF/GPS before they land (US-276) — neither of which
// can happen in code the uploader controls. So the browser never touches the
// bucket in either direction: it posts the file and asks for a signed URL.

/** What the file picker offers. The server re-checks by magic bytes regardless. */
export const RECEIPT_ACCEPT = "image/jpeg,image/png,image/webp,application/pdf";

/**
 * Mirrors the bucket's file_size_limit (migration 00564) and the route's cap.
 *
 * This copy is a COURTESY, not a control: rejecting a 40 MB photo here saves the
 * seller a slow upload that was always going to 400. The server's cap is the one
 * that matters and it is not derived from this.
 */
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

async function errorFrom(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

export async function uploadExpenseReceipt(
  expenseId: string,
  file: File,
): Promise<void> {
  if (file.size > MAX_RECEIPT_BYTES) {
    throw new Error("That file is over 10MB. Try a smaller photo or a PDF.");
  }
  const form = new FormData();
  form.append("receipt", file);
  // No Content-Type header: the browser has to set it so the multipart boundary
  // is included, and edgeFetch only forces one for its `json` option.
  const res = await edgeFetch(`/api/flipdesk/expenses/${expenseId}/receipt`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(await errorFrom(res, "Receipt upload failed."));
}

/** A short-lived signed URL. Not cached — it expires, and a stale one 403s. */
export async function expenseReceiptUrl(expenseId: string): Promise<string> {
  const res = await edgeFetch(`/api/flipdesk/expenses/${expenseId}/receipt`);
  if (!res.ok) throw new Error(await errorFrom(res, "Couldn't open the receipt."));
  const body = (await res.json()) as { url?: string };
  if (!body.url) throw new Error("Couldn't open the receipt.");
  return body.url;
}

export async function deleteExpenseReceipt(expenseId: string): Promise<void> {
  const res = await edgeFetch(`/api/flipdesk/expenses/${expenseId}/receipt`, {
    method: "DELETE",
  });
  if (!res.ok) {
    throw new Error(await errorFrom(res, "Couldn't remove the receipt."));
  }
}
