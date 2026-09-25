/**
 * Why the next SIGNED_OUT happened, for the one decision that depends on it:
 * whether the offline intake queue is deleted.
 *
 * A seller who signs out on purpose gets the queue wiped (a shared tablet must
 * not keep their cost, notes and GPS-tagged photos for the next account). A
 * session that died on its own is different. abandonDeadSession runs when a
 * refresh fails, and a refresh fails most often exactly when the seller is
 * offline, which is when the queue holds work that exists nowhere else.
 * Deleting it there loses a haul. Queued records carry `queuedBy`, and a flush
 * only replays the signed-in user's own, so keeping them exposes nothing to
 * the next account; they sync when the same seller signs back in.
 */
let keepOfflineQueue = false;

/** The coming SIGNED_OUT is involuntary: keep the offline intake queue. */
export function markInvoluntarySignOut(): void {
  keepOfflineQueue = true;
}

/** Read and reset the flag. True means keep the queue for this sign-out. */
export function consumeInvoluntarySignOut(): boolean {
  const keep = keepOfflineQueue;
  keepOfflineQueue = false;
  return keep;
}
