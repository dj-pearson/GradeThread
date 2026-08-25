// US-2869. What the user reads when something fails.
//
// THE DEFECT, CONFIRMED RATHER THAN ASSUMED. The convention is that a caller
// toasts what it caught, and 308 customer-facing call sites did exactly that:
// `toast.error(err instanceof Error ? err.message : "…")`, 132 of them with no
// fallback at all. Upstream, several edge routes put a raw PostgREST message
// straight into the `{ error }` body a toast then prints --
// flipdesk-consignment.ts (`insertErr?.message`), flipdesk-listings.ts
// (`error.message.slice(0, 200)`), flipdesk-measure.ts and
// flipdesk-autolister.ts. So a seller really could be shown
// `column listings.x does not exist`, learn nothing, and file a ticket.
//
// THREE LINES, ALWAYS, because one line can only ever be one of them:
//   title    what happened
//   meaning  what that means for you
//   action   the one thing to do next
//
// This module is PURE and has no imports from the app. Classification has to be
// unit-testable without a DOM, a toast library or a network, and the iOS twin
// (FriendlyErrorCopy) is `nonisolated` for the same reason.
//
// WHY STRING MATCHING AND NOT TYPED ERRORS. The same condition arrives in four
// shapes depending on where it came from: a `PostgrestError` with a SQLSTATE
// `code`, a GoTrue `AuthError` with a numeric `status` and a string `code`, a
// bare `Error` carrying whatever the edge put in `{ error }`, and a `TypeError`
// from fetch itself. Matching the flattened message plus whatever `status` and
// `code` happen to be present is the version-robust common denominator. iOS
// reached the same conclusion and says so in its own header.

/** The conditions this app actually produces. Kept in step with iOS via a fixture. */
export type FriendlyErrorKind =
  | "offline"
  | "sessionExpired"
  | "emailUnverified"
  | "invalidCredentials"
  | "rateLimited"
  | "planLimit"
  | "marketplaceReconnect"
  | "permission"
  | "notFound"
  | "validation"
  | "conflict"
  | "server"
  | "unknown";

export interface FriendlyError {
  kind: FriendlyErrorKind;
  /** What happened. Short enough for a toast title. */
  title: string;
  /** What it means for the user. */
  meaning: string;
  /** The one thing to do next, as an instruction. */
  action: string;
  /**
   * The original technical string. Goes to Sentry, and sits behind a Details
   * disclosure for support. NEVER the headline.
   */
  detail: string;
  /**
   * True when `detail` is copy we wrote (an edge route's own sentence) rather
   * than something a database or a marketplace generated. Only then may a
   * surface promote it into the visible text.
   */
  detailIsOurs: boolean;
}

/**
 * SQLSTATE classes that mean "this is a database talking".
 *
 * The presence of ANY of these is the strongest possible signal that the
 * message must not be shown: 42703 is the one in the story's title, and it
 * reads `column listings.x does not exist`.
 */
const SQLSTATE = /\b(0[0-9A-Z]|2[0-9A-Z]|4[0-9A-Z]|5[0-9A-Z]|P0)[0-9A-Z]{3}\b/;

/** Postgres codes worth naming, because each has a different thing to do. */
const PG_CODES: Record<string, FriendlyErrorKind> = {
  "23505": "conflict", // unique violation
  "23503": "conflict", // foreign key violation
  "23502": "validation", // not-null violation
  "22P02": "validation", // invalid text representation
  "42501": "permission", // insufficient privilege (an RLS refusal)
  PGRST301: "sessionExpired", // PostgREST: JWT expired
  PGRST116: "notFound", // PostgREST: no rows where one was required
};

function readField(err: unknown, key: string): unknown {
  if (!err || typeof err !== "object") return undefined;
  return (err as Record<string, unknown>)[key];
}

function statusOf(err: unknown): number | undefined {
  for (const key of ["status", "statusCode", "httpStatus"]) {
    const v = readField(err, key);
    if (typeof v === "number") return v;
    if (typeof v === "string" && /^\d{3}$/.test(v)) return Number(v);
  }
  return undefined;
}

function codeOf(err: unknown): string {
  const v = readField(err, "code");
  return typeof v === "string" ? v : "";
}

/**
 * The original technical string, for Sentry and the Details disclosure.
 *
 * Mirrors iOS `rawDetail(for:)`. Deliberately includes the SQLSTATE code when
 * there is one -- that code is the single most useful thing in a support
 * ticket, and hiding it from support to hide it from the user would be the
 * wrong trade.
 */
export function rawDetail(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  const message = readField(err, "message");
  const base =
    typeof message === "string" && message
      ? message
      : err instanceof Error
        ? err.message
        : String(err);
  const code = codeOf(err);
  const details = readField(err, "details");
  const parts = [base];
  if (code && !base.includes(code)) parts.push(`[${code}]`);
  if (typeof details === "string" && details && details !== base) {
    parts.push(details);
  }
  return parts.join(" ").trim();
}

/** True when the failure is reachability rather than a rejection. */
export function isOffline(err: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  // fetch rejects with a TypeError and no status. supabase-js wraps retryable
  // transport failures as AuthRetryableFetchError.
  const name = readField(err, "name");
  if (name === "AuthRetryableFetchError") return true;
  if (err instanceof TypeError && statusOf(err) === undefined) return true;
  const m = rawDetail(err).toLowerCase();
  return (
    m.includes("failed to fetch") ||
    m.includes("networkerror") ||
    m.includes("network request failed") ||
    m.includes("load failed") ||
    m.includes("err_internet_disconnected") ||
    m.includes("the internet connection appears to be offline")
  );
}

export function classifyError(err: unknown): FriendlyErrorKind {
  if (isOffline(err)) return "offline";

  const status = statusOf(err);
  const code = codeOf(err);
  const m = rawDetail(err).toLowerCase();

  // A named Postgres/PostgREST code beats everything below it: it is exact,
  // and it is the case where the raw text is certainly unshowable.
  if (PG_CODES[code]) return PG_CODES[code]!;

  // Marketplace reconnect BEFORE the generic 401/403 handling. It is a 409 or
  // a 401 depending on which eBay call failed, and the recovery is neither
  // "sign in again" nor "upgrade" -- it is "reconnect eBay", a different page.
  if (
    m.includes("reconnect-required") ||
    m.includes("reconnect required") ||
    m.includes("reconnect ebay") ||
    m.includes("invalid_grant") ||
    m.includes("token has expired") ||
    (m.includes("ebay") && (m.includes("not connected") || m.includes("reconnect")))
  ) {
    return "marketplaceReconnect";
  }

  if (
    status === 402 ||
    m.includes("payment_required") ||
    m.includes("plan limit") ||
    m.includes("upgrade your plan") ||
    m.includes("monthly limit") ||
    m.includes("quota exceeded")
  ) {
    return "planLimit";
  }

  if (
    status === 429 ||
    m.includes("rate limit") ||
    m.includes("rate_limit") ||
    m.includes("too many requests")
  ) {
    return "rateLimited";
  }

  if (
    m.includes("email not confirmed") ||
    m.includes("email_not_confirmed") ||
    m.includes("confirm your email")
  ) {
    return "emailUnverified";
  }

  if (
    m.includes("invalid login credentials") ||
    m.includes("invalid_credentials") ||
    m.includes("invalid email or password")
  ) {
    return "invalidCredentials";
  }

  if (
    status === 401 ||
    m.includes("jwt expired") ||
    m.includes("session expired") ||
    m.includes("you must be signed in") ||
    m.includes("not authenticated")
  ) {
    return "sessionExpired";
  }

  if (status === 403 || m.includes("forbidden") || m.includes("not allowed")) {
    return "permission";
  }
  if (status === 404 || m.includes("not found")) return "notFound";
  if (status === 409 || m.includes("already exists") || m.includes("duplicate")) {
    return "conflict";
  }
  if (status === 400 || m.includes("invalid") || m.includes("required")) {
    return "validation";
  }
  if (status !== undefined && status >= 500) return "server";

  // A bare SQLSTATE with no status is still a database talking, and the last
  // thing that should reach a seller.
  if (SQLSTATE.test(rawDetail(err)) && code) return "server";

  return "unknown";
}

/** title / meaning / action for each kind. */
const COPY: Record<FriendlyErrorKind, Omit<FriendlyError, "kind" | "detail" | "detailIsOurs">> = {
  offline: {
    title: "You are offline",
    meaning: "We could not reach GradeThread, so nothing was saved.",
    action: "Check your connection and try again.",
  },
  sessionExpired: {
    title: "You were signed out",
    meaning: "Your session ran out, so we could not finish that.",
    action: "Sign in again and repeat the last step.",
  },
  emailUnverified: {
    title: "Confirm your email first",
    meaning: "This feature is locked until your address is verified.",
    action: "Open the link we emailed you when you signed up.",
  },
  invalidCredentials: {
    title: "That did not match",
    meaning: "The email or password you entered is not right.",
    action: "Try again, or reset your password.",
  },
  rateLimited: {
    title: "Too many tries",
    meaning: "You have done that a lot in a short time, so we paused it.",
    action: "Wait a minute and try again.",
  },
  planLimit: {
    title: "Your plan does not cover that",
    meaning: "You have used everything your plan includes this month.",
    action: "Upgrade, or wait until your limit resets.",
  },
  marketplaceReconnect: {
    title: "eBay needs reconnecting",
    meaning: "Your eBay permission ran out, so we could not reach your account.",
    action: "Open Marketplaces and press Reconnect.",
  },
  permission: {
    title: "You cannot do that",
    meaning: "This belongs to someone else, or your role does not allow it.",
    action: "Ask the workspace owner, or open one of your own items.",
  },
  notFound: {
    title: "We could not find it",
    meaning: "It may have been deleted, or the link may be wrong.",
    action: "Go back and open it from the list.",
  },
  validation: {
    title: "Something is missing",
    meaning: "One of the details is empty or is not a shape we can use.",
    action: "Check the highlighted fields and try again.",
  },
  conflict: {
    title: "That already exists",
    meaning: "Something with the same details is already saved.",
    action: "Open the existing one, or change what you entered.",
  },
  server: {
    title: "Something broke on our side",
    meaning: "This is our fault, not yours. Nothing was saved.",
    action: "Try again in a minute. If it keeps happening, contact support.",
  },
  unknown: {
    title: "That did not work",
    meaning: "We could not finish what you asked for.",
    action: "Try again. If it keeps happening, contact support.",
  },
};

/**
 * Words that only ever appear when a database is talking.
 *
 * This replaced a "must start with a capital letter" rule, which was wrong in
 * the costly direction: it rejected "has a sale", which is OUR OWN explanation
 * of why a bulk delete skipped a row, and US-2173 asserts that exact wording
 * because it is the only thing standing between a seller and an oversell. A
 * fragment is still our copy. What is NOT ours is anything using these.
 */
const DB_VOCABULARY =
  /\b(violates?|constraint|relation|syntax error|duplicate key|null value|invalid input syntax|permission denied for|does not exist|unterminated)\b/i;

/**
 * True when a string reads like something WE wrote rather than something a
 * database or a marketplace generated.
 *
 * The distinction matters because the edge routes' own sentences ("Could not
 * start generation.") are better than any generic line here, while a PostgREST
 * message is worse than all of them. Conservative on purpose: anything holding
 * a SQLSTATE, a stack frame, a bracketed code, SQL punctuation or an
 * identifier-shaped token is treated as machine text.
 */
export function looksLikeOurCopy(s: string): boolean {
  const t = s.trim();
  if (t.length < 8 || t.length > 200) return false;
  if (!t.includes(" ")) return false;
  if (SQLSTATE.test(t)) return false;
  if (/[{}<>|\\]|::|\bat \w+\.\w+|https?:\/\//.test(t)) return false;
  if (/\b[a-z_]+\.[a-z_]+\b/.test(t)) return false; // table.column, obj.prop
  if (/\b[a-z]+_[a-z_]+\b/.test(t)) return false; // snake_case identifier
  if (DB_VOCABULARY.test(t)) return false;
  const letters = (t.match(/[a-zA-Z ]/g) ?? []).length;
  return letters / t.length > 0.85;
}

/**
 * Classify `err` and return the three lines plus the raw detail.
 *
 * `fallback` is the call site's own sentence, used as the title when the error
 * is unclassifiable. It is how 300-odd existing call sites keep the specific
 * copy they already had ("Bulk edit failed.") instead of all collapsing onto
 * "That did not work".
 */
export function friendlyError(err: unknown, fallback?: string): FriendlyError {
  const kind = classifyError(err);
  const detail = rawDetail(err);
  const detailIsOurs = looksLikeOurCopy(detail);
  const base = COPY[kind];

  if (kind === "unknown") {
    // Prefer, in order: the call site's own sentence, the server's own
    // sentence, then the generic. The server's is only used when it reads like
    // something a person wrote.
    // The call site's own sentence, then the server's, then the generic.
    //
    // When BOTH exist and the server's reads like ours, they are JOINED rather
    // than one dropped. A bulk summary needs both halves: "Couldn't delete 1.
    // First: Nike Polo" says how many and which, and "has a sale" says why.
    // Dropping the why is the regression US-2173's tests exist to catch.
    const own = fallback?.trim();
    const title =
      own && detailIsOurs && !own.includes(detail)
        ? `${own} ${detail}`
        : own || (detailIsOurs ? detail : base.title);
    return {
      kind,
      title,
      meaning: base.meaning,
      action: base.action,
      detail,
      detailIsOurs,
    };
  }

  return { kind, ...base, detail, detailIsOurs };
}

/** One line, for the places that genuinely have room for only one. */
export function friendlyErrorLine(err: unknown, fallback?: string): string {
  const f = friendlyError(err, fallback);
  return `${f.title}. ${f.action}`;
}
