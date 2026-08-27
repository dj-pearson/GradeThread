// US-2933: the deadline clock.
//
// eBay runs a timer on every post-sale case and decides against the seller when
// it expires. FlipDesk parsed `respondByDate` and threw it away: it notified
// ONCE, when the case opened, and then never again. A seller who read that
// notification on a Tuesday and got busy had nothing telling them Friday was
// the day, and a case lost to silence is indistinguishable from one lost on the
// merits — except that it was avoidable.
//
// ── WHY THIS IS NOT ITS OWN CRON ────────────────────────────────────────────
//
// The marketplace-events sweep already runs every 15 minutes, already holds the
// job lock, already has the list of connected sellers, and already owns the
// claim primitive that stops a reminder firing twice. A second cron would
// duplicate all four and add one more thing an operator has to install and
// watch. This is a step inside that sweep, so it is registered in the cron
// ledger as part of `marketplace-events` and cannot silently stop running while
// the sweep keeps reporting green.
//
// ── TWO REMINDERS, NOT A DRIP ───────────────────────────────────────────────
//
// T-48h and T-12h. Two is enough to catch a seller who is not looking, and few
// enough that the reminder still reads as urgent. An hourly nag on an open case
// teaches people to ignore the channel, which costs more cases than it saves.
//
// Overdue cases are NOT reminded. The deadline has passed; eBay has decided or
// is deciding, and a notification at that point is a reproach, not a prompt.

import { supabaseAdmin } from "./supabase.ts";
import type { PostSaleCaseType } from "./post-sale-store.ts";
import {
  type CaseDeadlineEvent,
  claimMarketplaceEvent,
  type MarketplaceEventKind,
  notifyCaseDeadline,
  releaseMarketplaceEvent,
} from "./marketplace-event-notify.ts";

/** Which reminder a deadline is due for, or null for neither. */
export type ReminderTier = "48h" | "12h";

const HOUR_MS = 3_600_000;

/**
 * Pure. Which reminder this deadline earns right now.
 *
 * The bands are half-open and ordered so a case cannot fall between them: a
 * deadline 12 hours out is in the 12h band, not the 48h one, and the claim on
 * the 48h reminder it already got does not stop the 12h one firing.
 *
 * Returns null for a deadline that is unreadable, already past, or still more
 * than 48 hours away.
 */
export function reminderTier(
  respondBy: string | null | undefined,
  nowMs: number,
): ReminderTier | null {
  if (!respondBy) return null;
  const due = Date.parse(respondBy);
  if (!Number.isFinite(due)) return null;
  const hoursLeft = (due - nowMs) / HOUR_MS;
  if (hoursLeft < 0) return null; // past — see the header
  if (hoursLeft <= 12) return "12h";
  if (hoursLeft <= 48) return "48h";
  return null;
}

/** How a stored case type maps onto the claim ledger's kind vocabulary. */
export function claimKindFor(caseType: PostSaleCaseType): MarketplaceEventKind {
  return caseType === "payment_dispute" ? "dispute" : caseType;
}

export interface DueCase {
  caseType: PostSaleCaseType;
  externalId: string;
  externalOrderId: string | null;
  reason: string | null;
  respondBy: string | null;
  amountCents: number | null;
  currency: string | null;
}

export interface ReminderDeps {
  loadDueCases: (ownerId: string) => Promise<DueCase[]>;
  claim: (
    ownerId: string,
    kind: MarketplaceEventKind,
    externalId: string,
    status: string,
    notificationType: string,
  ) => Promise<boolean>;
  release?: (
    ownerId: string,
    kind: MarketplaceEventKind,
    externalId: string,
    status: string,
  ) => Promise<void>;
  notify: (ev: CaseDeadlineEvent) => Promise<void>;
  now: () => number;
}

/**
 * One owner's open cases that carry a deadline.
 *
 * Owner-scoped (US-268) and bounded — a seller with hundreds of open cases has
 * a bigger problem than a missing reminder, and an unbounded read here would
 * make the sweep's runtime a function of the worst account on the platform.
 */
const DUE_CASE_SCAN_CAP = 200;

async function loadDueCasesFromDb(ownerId: string): Promise<DueCase[]> {
  const { data, error } = await supabaseAdmin
    .from("marketplace_post_sale_cases")
    .select("case_type, external_id, external_order_id, reason, respond_by, amount_cents, currency")
    .eq("user_id", ownerId)
    .eq("platform", "ebay")
    .is("closed_at", null)
    .not("respond_by", "is", null)
    .order("respond_by", { ascending: true })
    .limit(DUE_CASE_SCAN_CAP);
  if (error) {
    console.error("[post-sale-reminders] loadDueCases:", error.message);
    return [];
  }
  return ((data ?? []) as unknown as Array<{
    case_type: string;
    external_id: string;
    external_order_id: string | null;
    reason: string | null;
    respond_by: string | null;
    amount_cents: number | null;
    currency: string | null;
  }>).map((r) => ({
    caseType: r.case_type as PostSaleCaseType,
    externalId: r.external_id,
    externalOrderId: r.external_order_id,
    reason: r.reason,
    respondBy: r.respond_by,
    amountCents: r.amount_cents,
    currency: r.currency,
  }));
}

const defaultDeps: ReminderDeps = {
  loadDueCases: loadDueCasesFromDb,
  claim: claimMarketplaceEvent,
  release: releaseMarketplaceEvent,
  notify: notifyCaseDeadline,
  now: () => Date.now(),
};

/**
 * Fire the due reminders for one owner. Returns how many actually went out.
 *
 * Never throws: a reminder failure must not take down the sweep it rides in.
 */
export async function remindDueCasesForUser(
  ownerId: string,
  deps: ReminderDeps = defaultDeps,
): Promise<number> {
  let sent = 0;
  let cases: DueCase[] = [];
  try {
    cases = await deps.loadDueCases(ownerId);
  } catch (err) {
    console.error(
      "[post-sale-reminders] load failed:",
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }
  const nowMs = deps.now();
  for (const c of cases) {
    const tier = reminderTier(c.respondBy, nowMs);
    if (!tier) continue;
    const kind = claimKindFor(c.caseType);
    const status = `deadline_${tier}`;
    const fresh = await deps.claim(ownerId, kind, c.externalId, status, "case_deadline");
    if (!fresh) continue;
    try {
      await deps.notify({
        userId: ownerId,
        caseType: c.caseType,
        externalId: c.externalId,
        orderLabel: c.externalOrderId,
        reason: c.reason,
        respondBy: c.respondBy,
        tier,
        amountCents: c.amountCents,
        currency: c.currency,
      });
      sent++;
    } catch (err) {
      // Hand the claim back so the next sweep retries. Without this a failed
      // send is indistinguishable from a delivered one and the reminder is
      // simply lost — the same defect US-2319 fixed on the other sources.
      await deps.release?.(ownerId, kind, c.externalId, status);
      console.error(
        `[post-sale-reminders] ${c.caseType} ${c.externalId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return sent;
}
