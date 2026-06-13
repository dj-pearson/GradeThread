// US-596: public-API request ledger. Every authenticated /api/v1 call appends
// one row to api_usage_events so a partner's usage/billing dashboard can show
// call volume, success vs error rate, and free sandbox usage per key.
//
// This is REQUEST accounting (how many API calls a partner made), distinct from
// ai-usage.ts which is COST accounting (Anthropic tokens we spent per grade).

import { createMiddleware } from "hono/factory";
import { supabaseAdmin } from "./supabase.ts";
import { redactError } from "./log-redact.ts";

// Collapse concrete ids in a path into a stable bucket so per-id rows don't
// explode the dashboard. "/api/v1/grades/3f9c…/" → "/grades/:id".
const ID_SEGMENT = /^[0-9a-f]{8,}$|^[0-9a-f]{8}-[0-9a-f]{4}-/i;

export function normalizeApiPath(path: string): string {
  const noQuery = path.split("?")[0] ?? path;
  const stripped = noQuery.replace(/^\/api\/v1/, "") || "/";
  const segments = stripped.split("/").map((seg) =>
    ID_SEGMENT.test(seg) ? ":id" : seg,
  );
  const joined = segments.join("/").replace(/\/+$/, "");
  return joined.length > 0 ? joined : "/";
}

interface RecordArgs {
  userId: string | null;
  apiKeyId: string | null;
  endpoint: string;
  method: string;
  statusCode: number;
  sandbox: boolean;
}

// Fire-and-forget: usage accounting must never add latency to (or fail) the
// API response. Errors are logged and swallowed.
export function recordApiUsage(args: RecordArgs): void {
  if (!args.userId) return;
  supabaseAdmin
    .from("api_usage_events")
    .insert({
      user_id: args.userId,
      api_key_id: args.apiKeyId,
      endpoint: args.endpoint,
      method: args.method,
      status_code: args.statusCode,
      sandbox: args.sandbox,
    })
    .then(({ error }) => {
      if (error) {
        console.error("[api-usage] failed to record event:", redactError(error));
      }
    });
}

// Mount AFTER apiKeyAuthMiddleware on /api/v1/* so only authenticated calls are
// logged (a 401/429 returns before this runs and isn't billable usage). Records
// the outcome once the handler has produced a response.
export const apiUsageMiddleware = createMiddleware(async (c, next) => {
  await next();
  try {
    const path = c.req.path;
    recordApiUsage({
      userId: (c.get("userId") as string | undefined) ?? null,
      apiKeyId: (c.get("apiKeyId") as string | undefined) ?? null,
      endpoint: normalizeApiPath(path),
      method: c.req.method,
      statusCode: c.res.status,
      sandbox: path.includes("/sandbox"),
    });
  } catch (err) {
    console.error("[api-usage] middleware error:", redactError(err));
  }
});
