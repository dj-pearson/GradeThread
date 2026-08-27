// Marketplace-event poll (US-1055): the recurring source that surfaces NEW
// offers, returns, cancellation requests and payment disputes from eBay and
// notifies the seller.
//
// eBay's webhook stream tells us "something changed" but not "a return was just
// opened" with enough structure to notify cleanly, so a poll re-reads the open
// offers/returns/disputes for each connected seller and fires a notification the
// first time it sees each one. Idempotency is handled by claimMarketplaceEvent
// (a unique row per user+source+id+status), so re-polling the same open items
// never re-notifies.
//
// Tenant-scoped: every eBay read uses the connection owner's own access token
// (getUserAccessToken(ownerId)), so a poll can only ever read that owner's data.
// Each source is independent and best-effort — one seller's expired token or a
// disabled feature never breaks the others or the cron.

import { getBestOffers, type IncomingBestOffer } from "./ebay-trading.ts";
import {
  type CancellationSummary,
  type ReturnSummary,
  searchCancellations,
  searchReturns,
} from "./ebay-postorder.ts";
import { type PaymentDisputeSummary, searchPaymentDisputes } from "./ebay-disputes.ts";
import { type InquirySummary, searchInquiries } from "./ebay-inquiries.ts";
import { type CaseSummary, searchCases } from "./ebay-cases.ts";
import { remindDueCasesForUser } from "./post-sale-reminders.ts";
import { recordSnadObservations } from "./grade-snad-signal.ts";
import { sendOfferDigestForUser, utcDayStamp } from "./offer-digest.ts";
import { loadRankedOfferCandidates } from "./offer-candidates-load.ts";
import { isNegotiationScopeAvailable } from "./ebay-client.ts";
import {
  incomingOfferToInput,
  loadListPricesByItemId,
  type OfferInput,
  recordOffers,
} from "./offer-store.ts";
import { isClosedCase } from "./post-sale-state.ts";
import {
  cancellationToCaseInput,
  caseToCaseInput,
  disputeToCaseInput,
  linkPostSaleCases,
  inquiryToCaseInput,
  type PostSaleCaseInput,
  recordPostSaleCases,
  returnToCaseInput,
} from "./post-sale-store.ts";
import {
  type CancellationRequestedEvent,
  claimMarketplaceEvent,
  type DisputeOpenedEvent,
  type MarketplaceEventKind,
  notifyCancellationRequested,
  notifyDisputeOpened,
  notifyCaseOpened,
  notifyInquiryOpened,
  notifyOfferCandidateDigest,
  notifyOfferReceived,
  notifyReturnOpened,
  type CaseOpenedEvent,
  type InquiryOpenedEvent,
  type OfferReceivedEvent,
  releaseMarketplaceEvent,
  type ReturnOpenedEvent,
} from "./marketplace-event-notify.ts";

export interface MarketplacePollResult {
  offers: number;
  returns: number;
  disputes: number;
  cancellations: number;
  /** US-2928: Item Not Received inquiries. */
  inquiries: number;
  /** US-2929: escalated Money Back Guarantee cases — the ones that carry a defect. */
  cases: number;
  /** US-2933: deadline reminders fired on cases already known. */
  reminders: number;
  /** US-2936: stored cases newly linked to a local item. */
  linked: number;
  /** US-2937: SNAD accuracy observations written against a grade report. */
  snadSignals: number;
  /** US-2943: send-offer digests fired (at most one per seller per day). */
  digests: number;
  errors: string[];
}

// Seams for testing: the eBay fetchers, the idempotency claim, and the three
// emitters. Defaults wire to the real implementations; a unit test injects fakes
// (e.g. a Set-backed claim) to prove dedup + per-source isolation.
export interface MarketplacePollDeps {
  fetchOffers: (userId: string) => Promise<IncomingBestOffer[]>;
  fetchReturns: (userId: string) => Promise<ReturnSummary[]>;
  fetchDisputes: (userId: string) => Promise<PaymentDisputeSummary[]>;
  // US-2560. Optional so every existing fake keeps type-checking; an omitted
  // fetcher yields no cancellations rather than a crash, which is the safe way
  // for a seam to default and is what the other optional deps here already do.
  fetchCancellations?: (userId: string) => Promise<CancellationSummary[]>;
  // US-2928. Optional so every existing fake keeps type-checking; an omitted
  // fetcher yields no inquiries rather than a crash.
  fetchInquiries?: (userId: string) => Promise<InquirySummary[]>;
  // US-2929. Optional for the same reason as the others.
  fetchCases?: (userId: string) => Promise<CaseSummary[]>;
  claim: (
    userId: string,
    kind: MarketplaceEventKind,
    externalId: string,
    status: string,
    notificationType: string,
    // US-2156: the marketplace item the event happened on (00508). Optional so
    // existing fakes keep type-checking.
    itemExternalId?: string | null,
  ) => Promise<boolean>;
  // US-2319 AC3: hand a claim back when the notification it was taken for
  // fails, so the next poll retries instead of treating the failure as a
  // delivery. Optional so existing fakes keep type-checking; when a test omits
  // it, a failed notify simply does not retry — the OLD behaviour, which is the
  // safe way for a seam to default.
  release?: (
    userId: string,
    kind: MarketplaceEventKind,
    externalId: string,
    status: string,
  ) => Promise<void>;
  notifyOffer: (ev: OfferReceivedEvent) => Promise<void>;
  notifyReturn: (ev: ReturnOpenedEvent) => Promise<void>;
  notifyDispute: (ev: DisputeOpenedEvent) => Promise<void>;
  notifyCancellation?: (ev: CancellationRequestedEvent) => Promise<void>;
  notifyInquiry?: (ev: InquiryOpenedEvent) => Promise<void>;
  notifyCase?: (ev: CaseOpenedEvent) => Promise<void>;
  // US-2933: the deadline pass over cases ALREADY stored. Optional so existing
  // fakes keep type-checking; an omitted one simply sends no reminders.
  remind?: (ownerId: string) => Promise<number>;
  // US-2936: resolve eBay's order/item ids to local ones. Optional like the
  // others so existing fakes keep type-checking.
  link?: (ownerId: string) => Promise<number>;
  // US-2937: the accuracy signal. Optional like the rest.
  snad?: (ownerId: string) => Promise<number>;
  // US-2943: the once-a-day nudge about watchers worth an offer. Optional like
  // the rest, and a no-op when the deployment lacks the restricted scope.
  digest?: (ownerId: string) => Promise<number>;
  // US-2939: record the offers this poll saw. Optional so existing fakes keep
  // type-checking and a dedupe test needs no database.
  recordOffers?: (ownerId: string, inputs: OfferInput[]) => Promise<number>;
  // The asking price at the moment the offer is seen. A snapshot, not a lookup:
  // reading it later would divide a historic discount by today's price.
  loadListPrices?: (ownerId: string, itemIds: string[]) => Promise<Map<string, number>>;
  // US-2927: write what this poll saw to marketplace_post_sale_cases before it
  // decides whether to notify. A seam, and optional, so every existing fake
  // keeps type-checking and a test that only cares about notification dedupe
  // does not have to stub a database.
  record?: (ownerId: string, inputs: PostSaleCaseInput[]) => Promise<number>;
}

const defaultDeps: MarketplacePollDeps = {
  fetchOffers: getBestOffers,
  fetchReturns: (userId) => searchReturns(userId, { limit: 100 }),
  fetchDisputes: (userId) => searchPaymentDisputes(userId, { limit: 100 }),
  fetchCancellations: (userId) => searchCancellations(userId, { limit: 100 }),
  fetchInquiries: (userId) => searchInquiries(userId, { limit: 100 }),
  fetchCases: (userId) => searchCases(userId, { limit: 100 }),
  claim: claimMarketplaceEvent,
  release: releaseMarketplaceEvent,
  notifyOffer: notifyOfferReceived,
  notifyReturn: notifyReturnOpened,
  notifyDispute: notifyDisputeOpened,
  notifyCancellation: notifyCancellationRequested,
  notifyInquiry: notifyInquiryOpened,
  notifyCase: notifyCaseOpened,
  record: recordPostSaleCases,
  remind: remindDueCasesForUser,
  link: linkPostSaleCases,
  snad: recordSnadObservations,
  digest: (ownerId) =>
    // Gated on the deployment scope so a build without send-offer never spends
    // an eBay call per seller per tick to discover it still cannot send.
    isNegotiationScopeAvailable()
      ? sendOfferDigestForUser(ownerId, {
        loadCandidates: async (id) => (await loadRankedOfferCandidates(id)).candidates,
        claim: claimMarketplaceEvent,
        release: releaseMarketplaceEvent,
        notify: notifyOfferCandidateDigest,
        today: () => utcDayStamp(),
      })
      : Promise.resolve(0),
  recordOffers,
  loadListPrices: loadListPricesByItemId,
};

// A dispute in one of these states still needs the seller's attention; CLOSED /
// resolved disputes are not worth a (late) notification.
const ACTIONABLE_DISPUTE_STATUSES = new Set([
  "OPEN",
  "ACTION_NEEDED",
  "ACTION_REQUIRED",
  "WAITING_FOR_SELLER_RESPONSE",
]);

/**
 * Poll one owner's open offers/returns/disputes and notify on each newly-seen
 * one. Returns per-source counts of notifications actually fired. Never throws —
 * per-source failures are collected into `errors`.
 */
export async function pollMarketplaceEventsForUser(
  ownerId: string,
  deps: MarketplacePollDeps = defaultDeps,
): Promise<MarketplacePollResult> {
  const result: MarketplacePollResult = {
    offers: 0,
    returns: 0,
    disputes: 0,
    cancellations: 0,
    inquiries: 0,
    cases: 0,
    reminders: 0,
    linked: 0,
    snadSignals: 0,
    digests: 0,
    errors: [],
  };

  // ── Offers ────────────────────────────────────────────────────────
  try {
    const offers = await deps.fetchOffers(ownerId);
    // US-2939: record BEFORE the notify loop, for the same reason the post-sale
    // sources do — the loop `continue`s past an already-claimed offer, so
    // recording inside it would freeze each offer at the state it arrived in
    // and never see it expire.
    const listPrices = (await deps.loadListPrices?.(
      ownerId,
      offers.map((o) => o.itemId).filter(Boolean),
    )) ?? new Map<string, number>();
    await deps.recordOffers?.(
      ownerId,
      // `undefined` when we have no local listing, which LEAVES any stored
      // snapshot alone rather than nulling it — an offer seen once with a price
      // keeps that price even if the listing later goes missing.
      offers.map((o) => incomingOfferToInput(o, listPrices.get(o.itemId))),
    );
    for (const offer of offers) {
      if (!offer.bestOfferId) continue;
      const fresh = await deps.claim(
        ownerId,
        "offer",
        offer.bestOfferId,
        "received",
        "offer_received",
        offer.itemId || null,
      );
      if (!fresh) continue;
      // Per-event try/catch, not one around the batch. Two reasons, and both
      // were live defects: the claim has to be released so the next poll
      // retries this offer, and one failing notification used to abort the
      // remaining offers in the batch by unwinding to the source handler.
      try {
        await deps.notifyOffer({
          userId: ownerId,
          bestOfferId: offer.bestOfferId,
          itemTitle: offer.itemTitle,
          price: offer.price,
          currency: offer.currency,
          buyerUsername: offer.buyerUsername,
          expiresAt: offer.expiresAt,
        });
        result.offers++;
      } catch (err) {
        await deps.release?.(ownerId, "offer", offer.bestOfferId, "received");
        result.errors.push(
          `offer ${offer.bestOfferId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    result.errors.push(`offers: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Returns (Post-Order) ──────────────────────────────────────────
  try {
    const returns = await deps.fetchReturns(ownerId);
    // US-2927: record BEFORE the notify loop. The loop `continue`s past a
    // return that has already been claimed, so recording inside it would store
    // each case exactly once and never update it again.
    const nowIso = new Date().toISOString();
    await deps.record?.(ownerId, returns.map((r) => returnToCaseInput(r, nowIso)));
    for (const ret of returns) {
      if (!ret.returnId) continue;
      const fresh = await deps.claim(
        ownerId,
        "return",
        ret.returnId,
        "opened",
        "return_opened",
        ret.itemId || null,
      );
      if (!fresh) continue;
      try {
        await deps.notifyReturn({
          userId: ownerId,
          returnId: ret.returnId,
          itemLabel: ret.itemId ?? ret.orderId,
          reason: ret.reason,
        });
        result.returns++;
      } catch (err) {
        await deps.release?.(ownerId, "return", ret.returnId, "opened");
        result.errors.push(
          `return ${ret.returnId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    result.errors.push(`returns: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Cancellation requests (Post-Order) ────────────────────────────
  //
  // US-2560. searchCancellations() had been in ebay-postorder.ts since the
  // Post-sale page shipped, and no poll source read it — so this was the one
  // post-order case a seller could only find by going and looking, while eBay
  // ran a clock on it.
  try {
    const cancellations = (await deps.fetchCancellations?.(ownerId)) ?? [];
    const cancelNowIso = new Date().toISOString();
    await deps.record?.(
      ownerId,
      cancellations.map((c) => cancellationToCaseInput(c, cancelNowIso)),
    );
    for (const ca of cancellations) {
      if (!ca.cancelId) continue;

      // A cancellation the SELLER started is their own action. Notifying them
      // about it would fire on every Approve they press from the Post-sale page
      // — the notification arriving to tell them what they just did. Unknown
      // still notifies, per the default-open asymmetry the state rule uses.
      if (ca.requestorType?.trim().toUpperCase() === "SELLER") continue;

      // Closed cases are history. Unlike the dispute source above this is a
      // DENYLIST on terminal words rather than an allowlist of open states,
      // because it has to agree with what the Post-sale page calls open — a
      // notification whose row the page files under "Show closed" sends the
      // seller looking for work that appears not to exist.
      if (isClosedCase(ca.state)) continue;

      const fresh = await deps.claim(
        ownerId,
        "cancellation",
        ca.cancelId,
        "requested",
        "cancellation_requested",
        // A cancellation is keyed to an ORDER, not a listing — same as a
        // dispute, so the item link stays honestly null rather than borrowing
        // the order id into a column that means something else.
        null,
      );
      if (!fresh) continue;
      try {
        await deps.notifyCancellation?.({
          userId: ownerId,
          cancelId: ca.cancelId,
          orderLabel: ca.orderId,
          reason: ca.reason,
        });
        result.cancellations++;
      } catch (err) {
        await deps.release?.(ownerId, "cancellation", ca.cancelId, "requested");
        result.errors.push(
          `cancellation ${ca.cancelId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    result.errors.push(`cancellations: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Item Not Received inquiries (Post-Order) ──────────────────────
  //
  // US-2928. The webhook for these already arrived and already triggered this
  // poll — classifyEbayTopic routes INQUIRY_* to the return bucket — and the
  // poll then had no inquiry source, so the round trip ended in silence. This
  // is the source that was missing, not a new notification path.
  try {
    const inquiries = (await deps.fetchInquiries?.(ownerId)) ?? [];
    const inquiryNowIso = new Date().toISOString();
    await deps.record?.(
      ownerId,
      inquiries.map((i) => inquiryToCaseInput(i, inquiryNowIso)),
    );
    for (const inq of inquiries) {
      if (!inq.inquiryId) continue;
      // Same denylist-on-terminal-words rule the cancellation source uses, and
      // for the same reason: it has to agree with what the Post-sale page calls
      // open, or the seller is sent looking for work that is not there.
      if (isClosedCase(inq.state)) continue;
      const fresh = await deps.claim(
        ownerId,
        "inquiry",
        inq.inquiryId,
        "opened",
        "inquiry_opened",
        inq.itemId || null,
      );
      if (!fresh) continue;
      try {
        await deps.notifyInquiry?.({
          userId: ownerId,
          inquiryId: inq.inquiryId,
          orderLabel: inq.orderId ?? inq.itemId,
          reason: inq.reason,
          respondBy: inq.respondBy,
        });
        result.inquiries++;
      } catch (err) {
        await deps.release?.(ownerId, "inquiry", inq.inquiryId, "opened");
        result.errors.push(
          `inquiry ${inq.inquiryId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    result.errors.push(`inquiries: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Escalated cases (Post-Order case management) ──────────────────
  //
  // US-2929. The one post-sale event that costs a defect, and the one FlipDesk
  // had no reader for. Its notification deliberately says so — a case is not a
  // return with a different name, and a seller who treats it as one loses it.
  try {
    const cases = (await deps.fetchCases?.(ownerId)) ?? [];
    const caseNowIso = new Date().toISOString();
    await deps.record?.(ownerId, cases.map((x) => caseToCaseInput(x, caseNowIso)));
    for (const kase of cases) {
      if (!kase.caseId) continue;
      if (isClosedCase(kase.state)) continue;
      const fresh = await deps.claim(
        ownerId,
        "case",
        kase.caseId,
        "opened",
        "case_opened",
        kase.itemId || null,
      );
      if (!fresh) continue;
      try {
        await deps.notifyCase?.({
          userId: ownerId,
          caseId: kase.caseId,
          orderLabel: kase.orderId ?? kase.itemId,
          reason: kase.reason,
          respondBy: kase.respondBy,
        });
        result.cases++;
      } catch (err) {
        await deps.release?.(ownerId, "case", kase.caseId, "opened");
        result.errors.push(
          `case ${kase.caseId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    result.errors.push(`cases: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Payment disputes ──────────────────────────────────────────────
  try {
    // fetchDisputes (searchPaymentDisputes) already treats the eBay "no
    // disputes" 404 as an empty list, so a clean account is a no-op here.
    const disputes = await deps.fetchDisputes(ownerId);
    const disputeNowIso = new Date().toISOString();
    await deps.record?.(
      ownerId,
      disputes.map((d) => disputeToCaseInput(d, disputeNowIso)),
    );
    for (const dispute of disputes) {
      if (!dispute.paymentDisputeId) continue;
      if (dispute.status && !ACTIONABLE_DISPUTE_STATUSES.has(dispute.status.toUpperCase())) {
        continue;
      }
      const fresh = await deps.claim(ownerId, "dispute", dispute.paymentDisputeId, "opened", "dispute_opened");
      if (!fresh) continue;
      try {
        await deps.notifyDispute({
          userId: ownerId,
          disputeId: dispute.paymentDisputeId,
          orderLabel: dispute.orderId,
          reason: dispute.reason,
          amount: dispute.amount,
          currency: dispute.currency,
          respondByDate: dispute.respondByDate,
        });
        result.disputes++;
      } catch (err) {
        await deps.release?.(ownerId, "dispute", dispute.paymentDisputeId, "opened");
        result.errors.push(
          `dispute ${dispute.paymentDisputeId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  } catch (err) {
    result.errors.push(`disputes: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Link stored cases to local items (US-2936) ────────────────────
  //
  // AFTER every source has recorded and BEFORE the reminders, because the
  // reminder message names the order and the analytics join needs the item. One
  // pass for all five case types: the link is the same question each time, and
  // doing it per source would be five copies of one lookup.
  try {
    result.linked = (await deps.link?.(ownerId)) ?? 0;
  } catch (err) {
    result.errors.push(`link: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Grading-accuracy signal (US-2937) ─────────────────────────────
  //
  // AFTER the link, because an unlinked case cannot be attributed to a grade
  // report. A SIGNAL, never a verdict: it writes one grade_outcomes row tagged
  // marketplace_snad and touches no grade, no certificate and no public figure.
  try {
    result.snadSignals = (await deps.snad?.(ownerId)) ?? 0;
  } catch (err) {
    result.errors.push(`snad: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Send-offer digest (US-2943) ───────────────────────────────────
  //
  // Once a day per seller, enforced by the claim key rather than by a second
  // cron — see lib/offer-digest.ts. Costs one eBay eligibility call per seller
  // per DAY, not per tick, because an empty result claims nothing and a sent
  // digest claims the day.
  try {
    result.digests = (await deps.digest?.(ownerId)) ?? 0;
  } catch (err) {
    result.errors.push(`digest: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Deadline reminders (US-2933) ──────────────────────────────────
  //
  // LAST, and over the STORED cases rather than the freshly fetched ones. Every
  // source above has just upserted what it saw, so by this point the table is
  // current — and reading it rather than the fetch results is what lets one
  // pass cover all five case types instead of five near-identical blocks.
  try {
    result.reminders = (await deps.remind?.(ownerId)) ?? 0;
  } catch (err) {
    result.errors.push(`reminders: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

// ── Cron ────────────────────────────────────────────────────────────

/**
 * Sweep every active eBay connection and poll its owner's marketplace events.
 * Distinct owners only (a workspace's eBay connection lives on the owner). The
 * eBay reads are rate-bounded by eBay itself; the cron just bounds the fan-out.
 */
export async function sweepMarketplaceEvents(
  loadOwnerIds: () => Promise<string[]>,
): Promise<
  {
    users: number;
    offers: number;
    returns: number;
    disputes: number;
    cancellations: number;
    inquiries: number;
    cases: number;
    reminders: number;
    linked: number;
    snadSignals: number;
    digests: number;
    errors: number;
  }
> {
  const ownerIds = await loadOwnerIds();
  let offers = 0;
  let returns = 0;
  let disputes = 0;
  let cancellations = 0;
  let inquiries = 0;
  let cases = 0;
  let reminders = 0;
  let linked = 0;
  let snadSignals = 0;
  let digests = 0;
  let errors = 0;
  for (const ownerId of ownerIds) {
    const r = await pollMarketplaceEventsForUser(ownerId);
    offers += r.offers;
    returns += r.returns;
    disputes += r.disputes;
    cancellations += r.cancellations;
    inquiries += r.inquiries;
    cases += r.cases;
    reminders += r.reminders;
    linked += r.linked;
    snadSignals += r.snadSignals;
    digests += r.digests;
    errors += r.errors.length;
  }
  return {
    users: ownerIds.length,
    offers,
    returns,
    disputes,
    cancellations,
    inquiries,
    cases,
    reminders,
    linked,
    snadSignals,
    digests,
    errors,
  };
}
