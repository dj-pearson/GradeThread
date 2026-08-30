// US-2998 — the push itself.
//
// Every decision here is about running twice. The rule is: READ THE LOG, THEN
// WRITE. A source with a recorded QuickBooks id is updated or skipped; only a
// source with no record at all is created. Nothing in this file creates a
// document it has not first failed to find.
//
// The transport and the log are INJECTED, which is what lets AC5 be proved
// rather than asserted: the test runs the same push twice against an in-memory
// QuickBooks and counts the objects.

import {
  buildDocument,
  docNumberFor,
  isBlocked,
  type AccountMap,
  type PendingDocument,
  type QboObjectKind,
} from "./qbo-documents.ts";

export interface QboRef {
  id: string;
  syncToken: string;
}

/**
 * The QuickBooks side, reduced to what a push needs.
 *
 * `find` exists for one case and it matters: the log row is gone (restored
 * database, a failed write after a successful create) but the document is in
 * QuickBooks. Without it the next run creates a duplicate, which is precisely
 * the outcome this story exists to prevent.
 */
export interface QboTransport {
  find(entity: string, docNumber: string): Promise<QboRef | null>;
  create(entity: string, payload: Record<string, unknown>): Promise<QboRef>;
  update(
    entity: string,
    payload: Record<string, unknown>,
    ref: QboRef,
  ): Promise<QboRef>;
  /** AC2, best effort. A receipt that will not attach must not fail the push. */
  attachReceipt?(entity: string, qboId: string, sourceId: string): Promise<boolean>;
}

export interface SyncLogRow {
  object_kind: QboObjectKind;
  source_id: string;
  doc_number: string;
  qbo_id: string | null;
  qbo_sync_token: string | null;
  payload_hash: string | null;
  status: string;
}

export interface SyncLogStore {
  get(kind: QboObjectKind, sourceId: string): Promise<SyncLogRow | null>;
  put(row: SyncLogRow & { error_text: string | null }): Promise<void>;
}

export interface PushDeps {
  transport: QboTransport;
  log: SyncLogStore;
  map: AccountMap;
  bankAccountId?: string;
  /** AC3. Called only for deposits, and only when there is a payout to explain. */
  payoutSales?(
    sourceId: string,
  ): Promise<{ sale_id: string; sale_date: string; title: string }[]>;
  /** AC2. True when this expense has a receipt worth attaching. */
  hasReceipt?(sourceId: string): Promise<boolean>;
}

export interface PushResult {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  blocked: number;
  attached: number;
  /** Per-object, for the caller to surface. AC6. */
  entries: {
    kind: QboObjectKind;
    sourceId: string;
    docNumber: string;
    status: "created" | "updated" | "skipped" | "failed" | "blocked";
    error: string | null;
  }[];
}

export async function pushDocuments(
  docs: PendingDocument[],
  deps: PushDeps,
): Promise<PushResult> {
  const out: PushResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    blocked: 0,
    attached: 0,
    entries: [],
  };

  for (const doc of docs) {
    const docNumber = docNumberFor(doc.object_kind, doc.source_id);
    const existing = await deps.log.get(doc.object_kind, doc.source_id);

    const built = buildDocument(doc, deps.map, {
      bankAccountId: deps.bankAccountId,
      payoutSales: doc.object_kind === "deposit" && deps.payoutSales
        ? await deps.payoutSales(doc.source_id)
        : undefined,
    });

    if (isBlocked(built)) {
      out.blocked++;
      out.entries.push({
        kind: doc.object_kind,
        sourceId: doc.source_id,
        docNumber,
        status: "blocked",
        error: built.reason,
      });
      // Recorded, so the screen can say WHICH accounts are holding WHAT up. A
      // blocked document that leaves no trace is indistinguishable from one
      // that was never due.
      await deps.log.put({
        object_kind: doc.object_kind,
        source_id: doc.source_id,
        doc_number: docNumber,
        qbo_id: existing?.qbo_id ?? null,
        qbo_sync_token: existing?.qbo_sync_token ?? null,
        payload_hash: existing?.payload_hash ?? null,
        status: "blocked",
        error_text: built.reason,
      });
      continue;
    }

    // Nothing changed since the last accepted push. This is what makes a
    // nightly re-run of three years of history cost one query per document
    // instead of one write.
    if (existing?.qbo_id && existing.payload_hash === built.payloadHash) {
      out.skipped++;
      out.entries.push({
        kind: doc.object_kind,
        sourceId: doc.source_id,
        docNumber,
        status: "skipped",
        error: null,
      });
      continue;
    }

    try {
      let ref: QboRef | null = existing?.qbo_id
        ? { id: existing.qbo_id, syncToken: existing.qbo_sync_token ?? "0" }
        : null;

      // The log has no id. Before creating anything, ASK. This is the branch
      // that stands between a restored backup and a duplicate of the seller's
      // entire history.
      if (!ref) ref = await deps.transport.find(built.entity, built.docNumber);

      let status: "created" | "updated";
      if (ref) {
        ref = await deps.transport.update(built.entity, built.payload, ref);
        status = "updated";
        out.updated++;
      } else {
        ref = await deps.transport.create(built.entity, built.payload);
        status = "created";
        out.created++;
      }

      // AC2. After the document exists, and never in a way that can fail it:
      // an expense in QuickBooks without its receipt is still a correct
      // expense, while a push that aborts on a 10MB image is a lost expense.
      if (
        status === "created" &&
        doc.object_kind === "purchase" &&
        deps.transport.attachReceipt &&
        deps.hasReceipt &&
        (await deps.hasReceipt(doc.source_id))
      ) {
        try {
          if (await deps.transport.attachReceipt(built.entity, ref.id, doc.source_id)) {
            out.attached++;
          }
        } catch {
          // Deliberately swallowed. The status below stays "created".
        }
      }

      await deps.log.put({
        object_kind: doc.object_kind,
        source_id: doc.source_id,
        doc_number: built.docNumber,
        qbo_id: ref.id,
        qbo_sync_token: ref.syncToken,
        payload_hash: built.payloadHash,
        status,
        error_text: null,
      });
      out.entries.push({
        kind: doc.object_kind,
        sourceId: doc.source_id,
        docNumber: built.docNumber,
        status,
        error: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      out.failed++;
      out.entries.push({
        kind: doc.object_kind,
        sourceId: doc.source_id,
        docNumber: built.docNumber,
        status: "failed",
        error: message,
      });
      // The id is KEPT on a failure. Losing it would make the next run create a
      // second copy of a document that already exists -- turning one failed
      // push into permanent duplication.
      await deps.log.put({
        object_kind: doc.object_kind,
        source_id: doc.source_id,
        doc_number: built.docNumber,
        qbo_id: existing?.qbo_id ?? null,
        qbo_sync_token: existing?.qbo_sync_token ?? null,
        payload_hash: existing?.payload_hash ?? null,
        status: "failed",
        error_text: message.slice(0, 900),
      });
    }
  }

  return out;
}
