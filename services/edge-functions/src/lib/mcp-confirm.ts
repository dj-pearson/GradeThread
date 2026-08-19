// US-9116: the confirm token, and the reason every mutating tool is two calls.
//
// THE FAILURE THIS PREVENTS. A model that misreads one sentence can put twelve
// items live at the wrong price, and the seller finds out from a buyer. Asking
// the model to be careful is not a control. So no tool that publishes,
// reprices or ends anything acts on a single call: the first call PREVIEWS and
// returns a token, the second SPENDS it.
//
// The token is bound to four things, and each closes a different hole:
//
//   payload hash  — the preview and the action describe the SAME change. Bind
//                   only the ids and the price can move between the two calls.
//   subject       — the credential that previewed is the one that acts. Without
//                   it, a token leaked into a transcript is usable by anyone.
//   single use    — this is also the replay protection /api/v1 gets from
//                   Idempotency-Key, which MCP has no equivalent of.
//   short TTL     — a token found later is not a stored authorization. Ten
//                   minutes is long enough to ask the seller and short enough
//                   that it is not a standing permission.
//
// ELICITATION IS NOT A SUBSTITUTE, and neither is this on its own. On modern
// clients the publish tool ALSO elicits (MRTR, US-9116), which puts a real
// human in front of the action. Elicitation asks a person; the token proves the
// payload did not change between the question and the answer. A client with no
// elicitation support still cannot act without a token.
//
// In-memory and per-container, deliberately. A token IS an authorization, and
// one that survives a deploy is a standing permission nobody granted. Losing
// them on restart costs a re-preview, which is the correct trade.

export const CONFIRM_TOKEN_TTL_MS = 10 * 60_000;

/** How many tokens one subject may hold at once, to bound the store. */
const MAX_TOKENS_PER_SUBJECT = 50;

export interface ConfirmTokenRecord {
  token: string;
  /** The api key id (or OAuth grant) that previewed. */
  subject: string;
  /** Which tool the token is for; a publish token cannot end a listing. */
  toolName: string;
  /** Hash of the exact payload the preview described. */
  payloadHash: string;
  /** The ids the action will touch, for the audit trail and the error text. */
  targetIds: string[];
  expiresAtMs: number;
}

export type ConfirmFailure =
  | { reason: "unknown"; message: string }
  | { reason: "expired"; message: string }
  | { reason: "wrong_subject"; message: string }
  | { reason: "wrong_tool"; message: string }
  | { reason: "payload_changed"; message: string };

export type ConfirmResult =
  | { ok: true; record: ConfirmTokenRecord }
  | { ok: false; failure: ConfirmFailure };

const tokens = new Map<string, ConfirmTokenRecord>();

/**
 * A stable hash of the payload a preview described.
 *
 * Key order is normalised so a client that reserialises its own arguments does
 * not invalidate its token for no reason. Values are included, because the
 * whole point is that the PRICE cannot change between preview and confirm.
 */
export async function hashPayload(payload: unknown): Promise<string> {
  const canonical = canonicalize(payload);
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sweep(nowMs: number): void {
  for (const [token, record] of tokens) {
    if (record.expiresAtMs <= nowMs) tokens.delete(token);
  }
}

/** Drop the oldest tokens for a subject once it holds too many. */
function enforceSubjectCap(subject: string): void {
  const mine = [...tokens.values()]
    .filter((r) => r.subject === subject)
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs);
  while (mine.length > MAX_TOKENS_PER_SUBJECT) {
    const oldest = mine.shift();
    if (oldest) tokens.delete(oldest.token);
  }
}

export interface IssueArgs {
  subject: string;
  toolName: string;
  payload: unknown;
  targetIds: string[];
  nowMs?: number;
}

export async function issueConfirmToken(args: IssueArgs): Promise<ConfirmTokenRecord> {
  const nowMs = args.nowMs ?? Date.now();
  sweep(nowMs);

  const record: ConfirmTokenRecord = {
    token: `gtc_${crypto.randomUUID().replace(/-/g, "")}`,
    subject: args.subject,
    toolName: args.toolName,
    payloadHash: await hashPayload(args.payload),
    targetIds: args.targetIds,
    expiresAtMs: nowMs + CONFIRM_TOKEN_TTL_MS,
  };
  tokens.set(record.token, record);
  enforceSubjectCap(args.subject);
  return record;
}

export interface RedeemArgs {
  token: string;
  subject: string;
  toolName: string;
  payload: unknown;
  nowMs?: number;
}

/**
 * Spend a token, or say precisely why it cannot be spent.
 *
 * Every failure message tells the caller to RE-PREVIEW rather than to retry,
 * because retrying is what a model does by default and none of these failures
 * are fixed by it.
 */
export async function redeemConfirmToken(args: RedeemArgs): Promise<ConfirmResult> {
  const nowMs = args.nowMs ?? Date.now();

  // Look up BEFORE sweeping. Sweeping first collapses "expired" into
  // "unknown", and the two say different things to the caller: expired means
  // the preview was right and took too long, unknown means the token was never
  // valid. Only one of those is worth explaining to a seller.
  const record = tokens.get(args.token);
  sweep(nowMs);

  if (!record) {
    return {
      ok: false,
      failure: {
        reason: "unknown",
        message:
          "That confirmation token is not valid, or has already been used. " +
          "Preview the action again to get a fresh one.",
      },
    };
  }

  // Delete FIRST. A token that fails a later check is still spent: leaving it
  // usable would turn a wrong-subject attempt into an oracle a caller can probe
  // until it lines up.
  tokens.delete(args.token);

  if (record.expiresAtMs <= nowMs) {
    return {
      ok: false,
      failure: {
        reason: "expired",
        message: "That confirmation expired. Preview the action again to get a fresh one.",
      },
    };
  }
  if (record.subject !== args.subject) {
    return {
      ok: false,
      failure: {
        reason: "wrong_subject",
        message:
          "That confirmation was issued to a different credential. " +
          "Preview the action again with this one.",
      },
    };
  }
  if (record.toolName !== args.toolName) {
    return {
      ok: false,
      failure: {
        reason: "wrong_tool",
        message:
          `That confirmation was issued for ${record.toolName}, not ${args.toolName}. ` +
          "Preview this action to get its own confirmation.",
      },
    };
  }

  const hash = await hashPayload(args.payload);
  if (hash !== record.payloadHash) {
    return {
      ok: false,
      failure: {
        reason: "payload_changed",
        message:
          "The details changed since they were previewed, so the confirmation no longer " +
          "matches what would happen. Preview the action again and check the new numbers.",
      },
    };
  }

  return { ok: true, record };
}

/** Test seam: the store is process-local, so a suite must be able to reset it. */
export function __resetConfirmTokensForTest(): void {
  tokens.clear();
}

/** Test seam: how many tokens are outstanding. */
export function __confirmTokenCountForTest(): number {
  return tokens.size;
}
