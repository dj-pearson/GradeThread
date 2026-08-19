// US-9113: the connector's audit trail.
//
// One row per tool call, so "the AI did it" has a record behind it. Written by
// the dispatcher for every call, including the ones that were refused — a
// denied call is often the more interesting row, because it is what a probe
// looks like.
//
// FIRE AND FORGET. Writing the audit row must never add latency to, or fail, a
// tool call: an outage in the logging path would otherwise take the connector
// down with it. Errors are logged and swallowed, matching how last_used_at is
// handled in api-key-auth.ts.
//
// WHAT IS STORED, AND WHY SO LITTLE. Arguments are reduced to a SHAPE plus the
// ids that were acted on. An investigation needs "which item, which listing,
// when, by which key" — it does not need the base64 image bytes of a grading
// submission, a full listing description, or anything that could be a
// credential. Storing those would turn the audit log into a second copy of the
// data it exists to describe, retained for 400 days.

import { supabaseAdmin } from "./supabase.ts";
import { redactError } from "./log-redact.ts";

export type ToolCallStatus = "ok" | "error" | "denied" | "refused";

export interface ToolCallRecord {
  tenantId: string;
  apiKeyId: string | null;
  sessionId?: string | null;
  toolName: string;
  args: Record<string, unknown>;
  status: ToolCallStatus;
  errorCode?: string | null;
  durationMs?: number | null;
  costCents?: number | null;
}

/** Argument keys whose VALUE is an id worth keeping verbatim. */
const ID_KEYS = new Set([
  "item_id",
  "submission_id",
  "batch_id",
  "listing_id",
  "sale_id",
  "suggestion_id",
  "confirm_token_id",
  "slug",
  "marketplace",
  "status",
  "mode",
]);

/**
 * Anything whose name suggests a secret is dropped entirely, not summarised.
 * A shape summary of a credential still tells an attacker its length.
 */
const SECRET_HINTS = ["token", "secret", "key", "password", "authorization", "credential"];

const MAX_STRING = 120;
const MAX_KEYS = 20;

/**
 * US-9117: how many elements of an id-and-number array are kept verbatim.
 *
 * A reprice call carries `[{listing_id, price_cents}, ...]`, and summarising
 * that as {"type":"array","length":12} throws away the only part of the row an
 * investigation wants. Kept only for elements that are flat objects of ids and
 * numbers -- anything with a free-text field in it falls back to the summary,
 * so this cannot become a copy of a description.
 */
const MAX_ARRAY_ITEMS = 50;

/** Keys whose numeric value is worth keeping: money, counts, quantities. */
const NUMERIC_SUFFIXES = ["_cents", "_price", "_count", "_qty", "_percent", "_bps"];

function isKeepableNumberKey(key: string): boolean {
  const lower = key.toLowerCase();
  return NUMERIC_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * True when every entry is an id we already keep or a number we name above.
 * Deliberately strict: one unrecognised key and the whole element is dropped,
 * because the failure mode to avoid is a description landing in the audit table.
 */
function isIdAndNumberRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 8) return false;
  return entries.every(([key, entry]) => {
    if (looksSecret(key)) return false;
    // A boolean carries no free text, so its NAME does not have to be on a list.
    if (typeof entry === "boolean") return true;
    if (typeof entry === "number") return isKeepableNumberKey(key);
    if (typeof entry === "string") return ID_KEYS.has(key) && entry.length <= MAX_STRING;
    return false;
  });
}

function looksSecret(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_HINTS.some((hint) => lower.includes(hint));
}

/**
 * Reduce tool arguments to something safe and small.
 *
 * Ids and short enum-ish values are kept because they are what an investigation
 * is about. Everything else becomes a type-and-size summary: a description
 * becomes {"type":"string","length":812}, an image array becomes
 * {"type":"array","length":6}. The row then answers "what was acted on" without
 * becoming a copy of it.
 */
export function redactArguments(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let count = 0;

  for (const [key, value] of Object.entries(args ?? {})) {
    if (count >= MAX_KEYS) {
      out._truncated = true;
      break;
    }
    count++;

    if (key === "_meta") continue;
    if (looksSecret(key)) {
      out[key] = { type: "redacted" };
      continue;
    }

    if (value === null || value === undefined) {
      out[key] = null;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (typeof value === "string") {
      // An id or a short enum is the answer to "what did it act on"; a long
      // string is a description, and its content is not this table's business.
      out[key] = ID_KEYS.has(key) && value.length <= MAX_STRING
        ? value
        : { type: "string", length: value.length };
    } else if (Array.isArray(value)) {
      // US-9117: keep the rows when they are ids and money, summarise otherwise.
      out[key] = value.length > 0 && value.every(isIdAndNumberRecord)
        ? {
          type: "array",
          length: value.length,
          items: value.slice(0, MAX_ARRAY_ITEMS),
          ...(value.length > MAX_ARRAY_ITEMS ? { items_truncated: true } : {}),
        }
        : { type: "array", length: value.length };
    } else if (typeof value === "object") {
      // The handler-supplied detail is recursed into so its arrays get the
      // treatment above; anything else stays a shape summary as before.
      out[key] = key === "_detail"
        ? redactArguments(value as Record<string, unknown>)
        : { type: "object", keys: Object.keys(value as object).length };
    } else {
      out[key] = { type: typeof value };
    }
  }

  return out;
}

/**
 * Append one audit row. Never throws, never awaited by the caller's critical
 * path.
 */
export function recordToolCall(record: ToolCallRecord): void {
  const row = {
    owner_user_id: record.tenantId,
    api_key_id: record.apiKeyId,
    session_id: record.sessionId ?? null,
    tool_name: record.toolName,
    arguments_redacted: redactArguments(record.args),
    result_status: record.status,
    error_code: record.errorCode ?? null,
    duration_ms: record.durationMs ?? null,
    cost_cents: record.costCents ?? null,
  };

  supabaseAdmin
    .from("mcp_tool_calls")
    .insert(row)
    .then(({ error }) => {
      if (error) {
        console.error("[mcp-audit] failed to record tool call:", redactError(error));
      }
    });
}
