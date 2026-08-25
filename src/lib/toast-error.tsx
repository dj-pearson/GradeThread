import { toast } from "sonner";
import { captureException } from "@/lib/sentry";
import { friendlyError, type FriendlyError } from "@/lib/friendly-error";

// US-2869. The one way to tell a user something failed.
//
// It does three things no bare `toast.error(err.message)` can:
//   1. Says what happened, what it means, and what to do -- three lines, not
//      whatever sentence a database chose.
//   2. Keeps the technical string reachable behind Details, so a support
//      ticket can still carry the SQLSTATE that explains it.
//   3. Reports to Sentry every time, so the failures nobody reports are still
//      counted.
//
// WHY THE DETAILS DISCLOSURE IS A BUTTON AND NOT ALWAYS-VISIBLE TEXT. A toast
// is read in about two seconds. The raw string is for the one user in fifty who
// is going to paste it into a ticket, and putting it on screen for the other
// forty-nine is how the original defect looked in the first place.

/** Extra context attached to the Sentry event. */
export interface ToastErrorContext {
  /** What the user was trying to do, e.g. "publish listing". */
  action?: string;
  /** Anything else worth having in the ticket. */
  extra?: Record<string, unknown>;
  /**
   * How long the toast stays, in ms. Only for the failures a seller MUST
   * read: a batch where some rows published and some did not, or a delist
   * that failed while the listing is still live. Those cost money if missed,
   * and the default four seconds is not enough to read a count.
   */
  duration?: number;
  /**
   * Replaces the classifier's generic "what to do" line.
   *
   * Sometimes the call site knows the next step exactly and the classifier can
   * only guess: a 403 from the AI-enrichment endpoint is "permission" to the
   * classifier and "you switched this off in Settings" to the one screen that
   * calls it. The specific instruction always wins.
   */
  nextStep?: string;
  /**
   * Replaces the Details button.
   *
   * A toast has ONE action slot. Where the failure comes with an undo, the
   * undo is worth more than a technical string a support ticket can get from
   * Sentry anyway -- so passing this drops Details rather than fighting over
   * the slot.
   */
  toastAction?: { label: string; onClick: () => void };
}

/**
 * Copy the technical detail. Returns false when the clipboard is unavailable
 * (an insecure origin, or a browser that refuses), so the caller can say so
 * rather than silently doing nothing.
 */
async function copyDetail(detail: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(detail);
    return true;
  } catch {
    return false;
  }
}

/**
 * Show a failure the user can act on, and report it.
 *
 * `fallback` is this call site's own sentence. Pass it: when the error cannot
 * be classified, it becomes the headline, which is how a converted call site
 * keeps the specific copy it already had ("Bulk edit failed.") rather than
 * collapsing onto a generic line.
 */
export function toastError(
  err: unknown,
  fallback?: string,
  ctx?: ToastErrorContext,
): FriendlyError {
  const f = friendlyError(err, fallback);

  captureException(err, {
    tags: { friendly_kind: f.kind },
    extra: {
      ...ctx?.extra,
      user_action: ctx?.action,
      shown_title: f.title,
      raw_detail: f.detail,
    },
  });

  // The detail is only worth offering when it says something the three lines
  // do not. Our own copy that already became the title is not.
  const worthShowing =
    f.detail.length > 0 && f.detail !== f.title && !(f.detailIsOurs && f.detail === f.title);

  toast.error(f.title, {
    description: `${f.meaning} ${ctx?.nextStep ?? f.action}`,
    duration: ctx?.duration,
    action: ctx?.toastAction
      ? ctx.toastAction
      : worthShowing
      ? {
          label: "Details",
          onClick: () => {
            void copyDetail(f.detail).then((ok) => {
              toast.message(f.detail, {
                description: ok
                  ? "Copied. Paste this into a support ticket."
                  : "Copy this into a support ticket.",
                duration: 30_000,
              });
            });
          },
        }
      : undefined,
  });

  return f;
}

/**
 * The same thing for a warning: something went partly wrong and the user can
 * carry on. Same classification, same Sentry report, softer styling.
 */
export function toastWarning(
  err: unknown,
  fallback?: string,
  ctx?: ToastErrorContext,
): FriendlyError {
  const f = friendlyError(err, fallback);
  captureException(err, {
    level: "warning",
    tags: { friendly_kind: f.kind },
    extra: { ...ctx?.extra, user_action: ctx?.action, raw_detail: f.detail },
  });
  toast.warning(f.title, {
    description: `${f.meaning} ${ctx?.nextStep ?? f.action}`,
    duration: ctx?.duration,
    action: ctx?.toastAction,
  });
  return f;
}
