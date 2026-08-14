// US-2551: what went wrong when a Garment Passport claim fails, in the words a
// buyer standing in a shop can act on.
//
// Every failure used to collapse to "Couldn't claim this item. Please try
// again." — the same sentence for a signed-out visitor, a revoked tag, a chain
// somebody else already took, and a dropped connection. Three of those four are
// not retries, and telling someone to try again is actively wrong advice when
// the answer is "sign in" or "this tag will never work".
//
// It lives here rather than in the page so it can be tested directly, and so the
// scan page and the claim-link page cannot drift into two vocabularies for the
// same four outcomes.

export interface ClaimFailure {
  message: string;
  /** Whether trying the same request again could plausibly work. */
  canRetry: boolean;
}

/** `status` is null when the request never reached a response (offline, DNS, CORS). */
export function claimFailureMessage(status: number | null): ClaimFailure {
  if (status === 401 || status === 403) {
    return {
      message: "You need to be signed in to claim this item.",
      canRetry: false,
    };
  }
  if (status === 404) {
    return {
      message: "This tag is invalid or has been revoked, so it can't be claimed.",
      canRetry: false,
    };
  }
  if (status === 409 || status === 410) {
    return {
      message: "This item has already been claimed, or the link has expired.",
      canRetry: false,
    };
  }
  if (status === 429) {
    return {
      message:
        "Too many attempts from this connection. Wait a minute, then try again.",
      canRetry: true,
    };
  }
  // 5xx and "no response at all" are the only genuinely retryable cases.
  return {
    message: "We couldn't reach GradeThread to claim this item.",
    canRetry: true,
  };
}
