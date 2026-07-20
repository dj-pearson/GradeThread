// US-862: small client-side share helper shared by the viral-share CTAs
// (dashboard "Invite a friend" card, verified-seller "share your store").
// Native Web Share sheet where available, clipboard copy as the fallback.
// This is presentation-only — the referral program logic lives in the edge
// (referrals.ts) and is reused via its existing endpoints, not duplicated here.

import { toast } from "sonner";

export type ShareResult = "shared" | "copied" | "dismissed" | "failed";

/**
 * Whether the native share sheet is worth opening.
 *
 * `navigator.share` EXISTING is not the right test. Desktop Chrome on Windows
 * implements it, so the previous `typeof nav.share === "function"` check routed
 * desktop users into the OS share sheet — a modal listing Mail, printers and
 * nearby-sharing, which is strictly worse than copying a link and which several
 * users read as the button being broken.
 *
 * Gate on the PRIMARY pointer being coarse instead: that is true on phones and
 * tablets, where the sheet is genuinely the best affordance (it reaches native
 * apps the clipboard cannot), and false on desktop, including touchscreen
 * laptops driven by a mouse. Desktop then falls through to clipboard copy.
 */
export function prefersNativeShare(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  if (typeof (navigator as Navigator & { share?: unknown }).share !== "function") return false;
  return window.matchMedia?.("(pointer: coarse)").matches ?? false;
}

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

  if (nav && prefersNativeShare()) {
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
