// US-862: small client-side share helper shared by the viral-share CTAs
// (dashboard "Invite a friend" card, verified-seller "share your store").
// Native Web Share sheet where available, clipboard copy as the fallback.
// This is presentation-only — the referral program logic lives in the edge
// (referrals.ts) and is reused via its existing endpoints, not duplicated here.

import { toast } from "sonner";

export type ShareResult = "shared" | "copied" | "dismissed" | "failed";

/**
 * Open the native share sheet for `data`, falling back to copying `data.url`
 * to the clipboard. Shows a "copied" toast on the copy path. Returns how the
 * share resolved so callers can fire analytics with the right method.
 */
export async function shareOrCopy(data: {
  title?: string;
  text?: string;
  url: string;
  copiedMessage?: string;
}): Promise<ShareResult> {
  const { title, text, url, copiedMessage = "Link copied" } = data;

  const nav =
    typeof navigator !== "undefined"
      ? (navigator as Navigator & { share?: (d: ShareData) => Promise<void> })
      : undefined;

  if (nav && typeof nav.share === "function") {
    try {
      await nav.share({ title, text, url });
      return "shared";
    } catch (err) {
      // Dismissing the share sheet throws AbortError — not an error, and we
      // should NOT then copy (the user explicitly cancelled).
      if ((err as Error)?.name === "AbortError") return "dismissed";
      // Otherwise fall through to the clipboard fallback.
    }
  }

  try {
    await navigator.clipboard.writeText(url);
    toast.success(copiedMessage);
    return "copied";
  } catch {
    toast.error("Couldn't share — copy the link from your browser.");
    return "failed";
  }
}
