// AL-10: one loop for every multi-request AI pass on the AutoLister workbench
// (verify, propose). Each window costs one AI action, so the loop has to stop
// the moment the server says the seller is out of actions (402), not allowed
// (403) or being paced (429). It used to keep sending, and every later window
// was another refused request and another toast.

/** Statuses that mean "stop spending": out of actions, not allowed, paced. */
export const QUOTA_WALL_STATUSES: ReadonlySet<number> = new Set([402, 403, 429]);

export type WindowOutcome<R> =
  | { ok: true; value: R }
  | { ok: false; status: number | null; error: string | null };

export interface MeteredRunResult<W, R> {
  /** Windows that answered, in the order they were sent. */
  completed: { window: W; index: number; value: R }[];
  /** Windows that failed for any reason other than the wall. Retryable. */
  failed: W[];
  /** The refusal that stopped the run, if one did. */
  wall: { status: number; error: string | null } | null;
  /** True when the caller cancelled between windows. */
  cancelled: boolean;
  /** Windows that were never sent (after a wall or a cancel). */
  unsent: W[];
}

/**
 * Send `windows` one at a time. A thrown `send` counts as a failed window.
 * Stops (without sending the rest) on a quota wall or when `isCancelled`
 * turns true between windows.
 */
export async function runMeteredWindows<W, R>(
  windows: readonly W[],
  send: (window: W) => Promise<WindowOutcome<R>>,
  opts: { isCancelled?: () => boolean; onWindowDone?: (window: W, index: number) => void } = {},
): Promise<MeteredRunResult<W, R>> {
  const out: MeteredRunResult<W, R> = {
    completed: [],
    failed: [],
    wall: null,
    cancelled: false,
    unsent: [],
  };
  for (let i = 0; i < windows.length; i++) {
    const window = windows[i]!;
    if (opts.isCancelled?.()) {
      out.cancelled = true;
      out.unsent = windows.slice(i);
      break;
    }
    let outcome: WindowOutcome<R>;
    try {
      outcome = await send(window);
    } catch (err) {
      outcome = { ok: false, status: null, error: err instanceof Error ? err.message : null };
    }
    if (outcome.ok) {
      out.completed.push({ window, index: i, value: outcome.value });
    } else if (outcome.status != null && QUOTA_WALL_STATUSES.has(outcome.status)) {
      out.wall = { status: outcome.status, error: outcome.error };
      out.unsent = windows.slice(i);
      break;
    } else {
      out.failed.push(window);
    }
    opts.onWindowDone?.(window, i);
  }
  return out;
}

/**
 * AL-10: a propose run that stopped early (cancel or wall) keeps what it paid
 * for. The last answered window's final group may run on into the window that
 * was never sent, so it is dropped as unreliable; everything before it is kept.
 */
export function trimTrailingPartialGroup<G>(
  windowResults: readonly G[][],
  stoppedEarly: boolean,
): G[][] {
  if (!stoppedEarly || windowResults.length === 0) return [...windowResults];
  const last = windowResults[windowResults.length - 1]!;
  return [...windowResults.slice(0, -1), last.slice(0, -1)];
}
