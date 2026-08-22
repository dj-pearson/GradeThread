import type { StagedPhoto } from "@/stores/autolister-upload-store";

/**
 * The filename a staged photo came in as, or null when none is known.
 *
 * Two callers now, and they want it for different reasons — which is why it is
 * worth a file. The ungrouped grid SORTS by it, so IMG_9 lands before IMG_10;
 * and since US-2450 the grid also SPEAKS it, because a filename is how a seller
 * tells two shots of the same garment apart and a photo has no other name.
 *
 * PRE-sourceName PHOTOS RECOVER IT FROM sourceSig, whose shape is
 * `name|size|mtime`. The name may itself contain "|" — a file called
 * "front|back.jpg" is unusual and legal — so the two known trailing segments
 * are stripped and the rest is rejoined, rather than taking parts[0] and
 * truncating such a name at the first pipe.
 *
 * Returns null rather than a stand-in for a photo with no name at all, which is
 * what a Google Photos import produces. The callers decide what to do with
 * that: the sort sinks them to the end, and the label falls back to position.
 * A stand-in here would give every unnamed photo in a shoot the same one.
 */
export function stagedSortName(p: StagedPhoto): string | null {
  if (p.sourceName) return p.sourceName;
  if (p.sourceSig) {
    const parts = p.sourceSig.split("|");
    if (parts.length >= 3) return parts.slice(0, -2).join("|");
  }
  return null;
}
