import type { Run } from "@/lib/latest-run";

// US-3223. The bulk page is three-step precisely so an operator cannot
// fat-finger 200 accounts: paste targets, RESOLVE them server-side, then
// confirm. Confirm fires against `resolved`, so whatever is in `resolved` when
// the operator presses the button is who gets credited or suspended.
//
// The interleaving: the operator presses Resolve, then keeps editing the target
// box. Every keystroke calls resetResolution(), which clears `resolved` and is
// exactly the safety this flow depends on. But the resolve already in flight is
// not cancelled, and when it lands it puts the OLD list back — a list the
// operator can no longer see in the box above it. targetIds derives from it,
// readyToConfirm goes true, and Confirm suspends or credits accounts that were
// deleted from the paste.
//
// resetResolution() now supersedes the run, so a response that outlives its own
// target list is dropped instead of restored.

export interface ResolvedUser {
  input: string;
  user_id: string;
  email: string;
  full_name: string | null;
  suspended: boolean;
}

export interface ResolutionPatch {
  resolved: ResolvedUser[];
  unknown: string[];
}

/**
 * The patch a /admin/bulk/resolve response should apply, or null when the
 * target list it was computed from is gone.
 */
export function acceptResolution(
  run: Run,
  json: { resolved?: ResolvedUser[]; unknown?: string[] },
): ResolutionPatch | null {
  if (run.superseded) return null;
  return { resolved: json.resolved ?? [], unknown: json.unknown ?? [] };
}
