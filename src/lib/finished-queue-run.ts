// US-3425: what to say about a queued cross-post that RAN and still wants you.
//
// THE THIRD LIST EXISTS BECAUSE NEITHER OF THE OTHER TWO CAN CARRY IT, and the
// danger is asymmetric. `pending` renders as "Runs in your desktop browser",
// which is merely wrong about a run that already happened. `needsAttention`
// renders as "Nothing happened on the marketplace, do it there yourself, or
// queue it again" -- and a seller who follows that instruction after a run that
// DID happen posts the same garment twice. So a finished row needs its own
// words, which is why the edge gave it its own key in the first place
// (flipdesk-extension-queue.ts, US-3370).
//
// Pure, and separate from the component, because the sentence is the whole
// deliverable here: the data has been on the wire since US-3370 and what was
// missing was something to say about it.

import { photoWitnessState } from "@/lib/lister-extension";
import { MARKETPLACE_LABELS } from "@/lib/constants";
import { safeHref } from "@/lib/safe-url";

/** The result fields this reads. A superset arrives; these are the ones used. */
export interface FinishedRunResult {
  photosWitness?: string | null;
  photosTotal?: number;
  photosFailed?: number;
  photosAttached?: boolean;
  manual?: boolean;
  unverified?: boolean;
  error?: string | null;
  listingUrl?: string | null;
}

export interface FinishedRunNote {
  /** One sentence, already naming the marketplace. Never empty. */
  sentence: string;
  /**
   * Whether this is the photo case. The photo case is the one a seller has to
   * act on before a buyer sees the listing, so it is the one drawn in red.
   */
  severity: "alarm" | "notice";
  /** A safe href to the live listing, or null. The route to fixing it. */
  href: string | null;
}

export function marketplaceLabel(platform: string): string {
  return (
    MARKETPLACE_LABELS[platform as keyof typeof MARKETPLACE_LABELS] ?? platform
  );
}

/**
 * One finished result, one sentence.
 *
 * The causes are checked in the order `finishedNeedsReview()` checks them, so
 * a row that qualifies for two reasons is described by the same one the edge
 * qualified it on. Photos first, because a listing with no images is the
 * failure the whole US-2738 chain is named after and the only one a buyer sees
 * immediately.
 */
export function finishedRunNote(
  platform: string,
  result: FinishedRunResult | null | undefined,
): FinishedRunNote {
  const label = marketplaceLabel(platform);
  const href = safeHref(result?.listingUrl ?? null) ?? null;
  const notice = (sentence: string): FinishedRunNote =>
    ({ sentence, severity: "notice", href });
  const alarm = (sentence: string): FinishedRunNote =>
    ({ sentence, severity: "alarm", href });

  if (!result) {
    // The edge only puts a row here when its result qualified, so a null one
    // should be unreachable. Saying "look at it" is the safe unreachable
    // branch; saying nothing would render a row with no words on it.
    return notice(`This ${label} run finished and needs a look.`);
  }

  // The page was handed the files, was asked for a preview, and rendered
  // nothing out of them. The listing is live with no images on it.
  if (photoWitnessState(result) === "refused") {
    return alarm(
      `The ${label} form was filled but the photos never went on, so the ` +
        `listing has no images. Add them on ${label}.`,
    );
  }

  const failed = result.photosFailed ?? 0;
  if (failed > 0) {
    const total = result.photosTotal ?? failed;
    // "2 of 8" rather than "some": the difference between a seller fixing it
    // now and finding out from a buyer.
    return alarm(
      `${failed} of ${total} photos did not go on the ${label} listing. ` +
        `Add the rest on ${label}.`,
    );
  }

  if (result.manual === true) {
    return notice(`The ${label} listing needs finishing by hand on ${label}.`);
  }

  if (result.unverified === true) {
    // Never "it saved". Nothing proved it did, and that is the whole reason
    // the flag exists.
    return notice(
      `We could not confirm the ${label} listing saved. Check it on ${label}.`,
    );
  }

  const error = typeof result.error === "string" ? result.error.trim() : "";
  if (error) {
    // The server writes for a person, so it is shown as-is rather than
    // reworded into something vaguer.
    return notice(`${label}: ${error}`);
  }

  return notice(`This ${label} run finished and needs a look.`);
}
