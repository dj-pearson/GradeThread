// US-3409: recording the listing the extension just watched go live.
//
// THE BUG THIS EXISTS TO END. `listing-kit.tsx` did the writeback inline and
// answered a non-2xx with `if (!wb.ok) return;`. edgeFetch resolves rather than
// throwing (its own header says callers must inspect `res.ok`), so the check was
// there, it worked, and the answer went in the bin. The seller's listing was
// live on the marketplace and absent from FlipDesk, and the only trace was a
// `[WRITEBACK_INSERT] ...` line in a Coolify container log that nobody reads
// until somebody complains. That is exactly how US-2726 and US-2727 were found.
//
// Two things are wrong with a bare early return here and only one of them is the
// missing message:
//   1. It gives up on the first try. Half of what kills this call is transient
//      (the edge restarting, a PostgREST schema reload, a dropped connection),
//      and the listing is already live, so there is nothing to be careful about
//      in trying again.
//   2. Nothing counts it. A failure that reaches no human and no counter is a
//      failure that gets fixed after a seller notices, not before.
//
// So: retry the failures that a retry can fix, report the ones it cannot, and
// hand the caller a value it has to look at.

import { edgeFetch } from "@/lib/edge-fetch";
import { captureException } from "@/lib/sentry";

/** How many times the writeback is attempted before the seller is told. */
export const CAPTURE_MAX_ATTEMPTS = 3;

/** Waits between attempt 1→2 and 2→3. Short: the seller may be looking. */
const BACKOFF_MS = [600, 2400];

export interface CaptureFailure {
  kind: "failed";
  /** How many times the writeback was actually sent. */
  attempts: number;
  /** Status of the last answer. Null when there never was one (network). */
  status: number | null;
  /** The edge's own code, e.g. `WRITEBACK_INSERT`. Null when it sent none. */
  code: string | null;
  /** The one string worth quoting in a support ticket. */
  ref: string;
}

export type CaptureOutcome =
  | { kind: "recorded"; attempts: number }
  | CaptureFailure;

/**
 * Which failures are worth sending again.
 *
 * A 5xx, a 408 and a dead connection are the edge or the network having a bad
 * second. A 4xx is the server telling us this request is wrong — the same bytes
 * a second later get the same answer, and retrying only delays the message. 429
 * is deliberately NOT retried: it is a limiter, and hammering it is how a soft
 * limit becomes a hard one.
 */
function retryable(status: number | null): boolean {
  if (status === null) return true;
  return status >= 500 || status === 408;
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RecordCaptureInput {
  itemId: string;
  platform: string;
  /** The live URL the extension captured, when it caught one. */
  listingUrl?: string | null;
  /**
   * Whether this records a PUBLISHED listing. The automatic capture always
   * does — the extension saw the marketplace navigate to the live listing.
   */
  published?: boolean;
  /** Injected by the tests. Defaults to the real edgeFetch. */
  post?: typeof edgeFetch;
  /** Injected by the tests, so a retry costs no wall-clock. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected by the tests. Defaults to the real Sentry capture. */
  report?: typeof captureException;
}

/**
 * Record a cross-listing the extension watched go live, retrying the failures a
 * retry can fix and reporting the ones it cannot.
 *
 * Never throws: a caller in a `message` listener has nowhere to put a throw, and
 * the whole point of the story is that the answer must be a value somebody has
 * to read.
 */
export async function recordExtensionCapture(
  input: RecordCaptureInput,
): Promise<CaptureOutcome> {
  const post = input.post ?? edgeFetch;
  const sleep = input.sleep ?? wait;
  const report = input.report ?? captureException;

  let status: number | null = null;
  let code: string | null = null;
  let attempts = 0;

  for (let i = 0; i < CAPTURE_MAX_ATTEMPTS; i++) {
    attempts = i + 1;
    status = null;
    code = null;
    try {
      const res = await post("/api/flipdesk/listings/extension-writeback", {
        method: "POST",
        json: {
          item_id: input.itemId,
          platform: input.platform,
          published: input.published ?? true,
          listing_url: input.listingUrl ?? null,
        },
      });
      if (res.ok) return { kind: "recorded", attempts };
      status = res.status;
      const body = (await res.json().catch(() => ({}))) as { code?: string };
      code = typeof body.code === "string" ? body.code : null;
    } catch {
      // A thrown edgeFetch is "no answer at all" — an offline tab, a DNS
      // failure, or no session. Same treatment as a 5xx: worth one more try.
      status = null;
      code = null;
    }
    if (!retryable(status)) break;
    const backoff = BACKOFF_MS[i];
    if (backoff !== undefined && i < CAPTURE_MAX_ATTEMPTS - 1) await sleep(backoff);
  }

  const ref = code ?? (status === null ? "no answer" : String(status));
  const failure: CaptureFailure = { kind: "failed", attempts, status, code, ref };

  // AC2. The Coolify log is not a place anyone looks. This is the same lazy
  // Sentry façade toast-error.tsx reports through (src/lib/sentry.ts), so it
  // costs nothing in the eager bundle and lands beside every other report.
  report(
    new Error(
      `extension writeback failed (${ref}) after ${attempts} attempt` +
        (attempts === 1 ? "" : "s"),
    ),
    {
      tags: { surface: "flipdesk.extension-capture", capture_ref: ref },
      extra: {
        platform: input.platform,
        item_id: input.itemId,
        status,
        code,
        attempts,
        // The URL itself is a public marketplace link, but it is still the
        // seller's, and the fact of having one is what debugging needs.
        had_listing_url: Boolean(input.listingUrl),
      },
    },
  );

  return failure;
}
