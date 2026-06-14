// US-882: unified dead-letter console — pure helpers.
//
// DB-free logic for the cross-provider DLQ surface (/api/admin/ops/dead-letters)
// so unification, filtering, pagination, replayability and the audit shapes are
// all unit-testable without a live database (mirrors the ops-jobs pure/route
// split from US-881).
//
// Two SOURCES feed the console:
//   • "webhook" — webhook_dead_letters rows (provider stripe/ebay/appstore/
//     content) still in the 'unresolved' state.
//   • "email"   — email_deliveries rows in the 'dead_letter' state.
//
// Each is mapped to one UnifiedDeadLetter shape so the UI renders a single list
// with a source tab + provider filter.

export type DeadLetterSource = "webhook" | "email";

export const DEAD_LETTER_SOURCES: readonly DeadLetterSource[] = ["webhook", "email"];

export function isDeadLetterSource(v: unknown): v is DeadLetterSource {
  return v === "webhook" || v === "email";
}

// Bounded window pulled per table for the merge+paginate (mirrors ops-jobs'
// RUNS_WINDOW). Dead letters are rare, so this comfortably covers the active
// queue; the route logs if a table is ever fully saturated.
export const DEAD_LETTER_WINDOW = 500;

// One durable bulk tick processes at most this many items, then reports how many
// remain so the client re-issues another bounded server-side batch rather than
// looping per-item (AC#4).
export const BULK_BATCH_LIMIT = 25;

// How many fresh attempts a re-queued email gets. Added to its current attempt
// count so the email-retry cron (the email's "normal handler") actually picks it
// back up off the dead-letter pile.
export const EMAIL_RETRY_BUDGET = 3;

// ── Source row shapes (as selected from each table) ──────────────

export interface WebhookDeadLetterRow {
  id: string;
  provider: string;
  event_id: string;
  event_type: string | null;
  payload: unknown;
  error_message: string | null;
  status: string;
  replay_attempts: number | null;
  last_replay_at: string | null;
  created_at: string;
}

export interface EmailDeadLetterRow {
  id: string;
  recipient: string;
  subject: string;
  category: string;
  status: string;
  attempts: number | null;
  max_attempts: number | null;
  last_error: string | null;
  created_at: string;
}

// ── Unified shape ────────────────────────────────────────────────

export interface UnifiedDeadLetter {
  source: DeadLetterSource;
  id: string;
  // stripe/ebay/appstore/content for webhooks; the email category for email.
  provider: string;
  // event type (webhook) or recipient subject (email) — a human label.
  reference: string;
  payload_preview: string;
  last_error: string | null;
  attempt_count: number;
  age_seconds: number;
  created_at: string;
  status: string;
  // Whether the console can replay this item (AC#2). eBay/AppStore webhooks have
  // no server-side replay path, so they're inspect/discard-only.
  replayable: boolean;
}

// Webhook providers we can actually re-dispatch from the console. Stripe is
// re-fetched + re-run through its handler; content is re-dispatched from the
// stored payload. eBay/AppStore have no replay path (they only ack today).
const REPLAYABLE_WEBHOOK_PROVIDERS: ReadonlySet<string> = new Set(["stripe", "content"]);

export function isWebhookReplayable(provider: string): boolean {
  return REPLAYABLE_WEBHOOK_PROVIDERS.has(provider);
}

/** Truncated single-line JSON preview of a payload for the list view. */
export function payloadPreview(payload: unknown, max = 280): string {
  let s: string;
  try {
    s = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
  } catch {
    s = String(payload);
  }
  s = (s ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function ageSeconds(createdAt: string, now: Date): number {
  const ms = now.getTime() - new Date(createdAt).getTime();
  return ms > 0 ? Math.floor(ms / 1000) : 0;
}

export function toUnifiedFromWebhook(row: WebhookDeadLetterRow, now: Date): UnifiedDeadLetter {
  return {
    source: "webhook",
    id: row.id,
    provider: row.provider,
    reference: row.event_type ?? row.event_id,
    payload_preview: payloadPreview(row.payload),
    last_error: row.error_message,
    attempt_count: row.replay_attempts ?? 0,
    age_seconds: ageSeconds(row.created_at, now),
    created_at: row.created_at,
    status: row.status,
    replayable: isWebhookReplayable(row.provider),
  };
}

export function toUnifiedFromEmail(row: EmailDeadLetterRow, now: Date): UnifiedDeadLetter {
  return {
    source: "email",
    id: row.id,
    // Use the category as the "provider" axis so the provider filter works
    // uniformly across both sources.
    provider: row.category,
    reference: row.subject,
    payload_preview: payloadPreview({ to: row.recipient, subject: row.subject }),
    last_error: row.last_error,
    attempt_count: row.attempts ?? 0,
    age_seconds: ageSeconds(row.created_at, now),
    created_at: row.created_at,
    status: row.status,
    // A dead-lettered email is always re-queueable to the outbox.
    replayable: true,
  };
}

// ── Query parsing + pagination ───────────────────────────────────

export interface DeadLetterQuery {
  source: DeadLetterSource | null;
  provider: string | null;
  page: number;
  pageSize: number;
}

export function parseDeadLetterQuery(get: (k: string) => string | undefined): DeadLetterQuery {
  const sourceRaw = get("source");
  const providerRaw = (get("provider") ?? "").trim();
  return {
    source: isDeadLetterSource(sourceRaw) ? sourceRaw : null,
    provider: providerRaw || null,
    page: Math.max(1, Math.floor(Number(get("page")) || 1)),
    pageSize: Math.min(100, Math.max(1, Math.floor(Number(get("page_size")) || 50))),
  };
}

export interface UnifiedPage {
  items: UnifiedDeadLetter[];
  page: number;
  page_size: number;
  total: number;
  providers: string[];
}

/**
 * Merge both sources into one list, apply the source + provider filters, sort
 * newest-first and return the requested page. `providers` is the distinct
 * provider set across the FILTERED-by-source (not by-provider) rows, so the UI
 * can populate its provider dropdown.
 */
export function buildUnifiedPage(
  rows: UnifiedDeadLetter[],
  query: DeadLetterQuery,
  now: Date,
): UnifiedPage {
  void now;
  const bySource = query.source ? rows.filter((r) => r.source === query.source) : rows;
  const providers = Array.from(new Set(bySource.map((r) => r.provider))).sort();

  const filtered = query.provider
    ? bySource.filter((r) => r.provider === query.provider)
    : bySource;
  filtered.sort((a, b) =>
    a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0
  );

  const total = filtered.length;
  const start = (query.page - 1) * query.pageSize;
  return {
    items: filtered.slice(start, start + query.pageSize),
    page: query.page,
    page_size: query.pageSize,
    total,
    providers,
  };
}

// ── Audit shapes ─────────────────────────────────────────────────

export const DLQ_RETRY_AUDIT_ACTION = "ops.dead_letter_retry";
export const DLQ_DISCARD_AUDIT_ACTION = "ops.dead_letter_discard";
export const DLQ_BULK_AUDIT_ACTION = "ops.dead_letter_bulk";

export function retryAudit(source: DeadLetterSource, id: string, provider: string) {
  return {
    action: DLQ_RETRY_AUDIT_ACTION,
    targetType: "dead_letter",
    targetId: `${source}:${id}`,
    details: { source, provider },
  };
}

export function discardAudit(
  source: DeadLetterSource,
  id: string,
  provider: string,
  reason: string,
) {
  return {
    action: DLQ_DISCARD_AUDIT_ACTION,
    targetType: "dead_letter",
    targetId: `${source}:${id}`,
    details: { source, provider, reason },
  };
}

export function bulkAudit(
  action: "retry" | "discard",
  query: { source: DeadLetterSource | null; provider: string | null; ids?: string[] },
  result: { processed: number; succeeded: number; failed: number },
  reason?: string,
) {
  return {
    action: DLQ_BULK_AUDIT_ACTION,
    targetType: "dead_letter",
    targetId: null,
    details: {
      bulk_action: action,
      source: query.source,
      provider: query.provider,
      explicit_ids: query.ids?.length ?? 0,
      ...result,
      ...(reason ? { reason } : {}),
    },
  };
}

// Validate a discard reason (required, non-empty, bounded). Returns the trimmed
// reason or null when invalid.
export function normalizeDiscardReason(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  return t.slice(0, 1000);
}
