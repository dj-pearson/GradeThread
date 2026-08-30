// US-2998 — turning a group of ledger entries into a QuickBooks document.
//
// PURE. No network, no database, no clock. Everything that decides what
// QuickBooks receives lives here so it can be tested without either, and the
// syncer beside it does nothing but fetch, call and record.
//
// THE ONE RULE THAT MATTERS: a re-run must not create a second copy. Every
// document carries a DocNumber derived from what it came FROM, and the syncer
// checks the log before it writes. The number is deterministic, so even a lost
// log can find the existing document rather than duplicating it.

export type QboObjectKind = "sales_receipt" | "purchase" | "deposit";

export interface PendingLine {
  account_code: string;
  amount_cents: number;
  memo: string | null;
  detail: string;
}

export interface PendingDocument {
  object_kind: QboObjectKind;
  source_id: string;
  doc_date: string;
  memo: string | null;
  currency: string | null;
  total_cents: number;
  /** Facilitator sales tax, excluded from the total. Reported, not booked. */
  excluded_tax_cents: number;
  lines: PendingLine[];
}

/** account_code -> QuickBooks account id. Absence means unmapped. */
export type AccountMap = Record<string, string>;

export interface BuiltDocument {
  kind: QboObjectKind;
  /** The QBO REST entity path: "salesreceipt", "purchase", "deposit". */
  entity: string;
  docNumber: string;
  payload: Record<string, unknown>;
  /** Stable across runs when nothing changed. Drives the skip. */
  payloadHash: string;
}

export interface BlockedDocument {
  kind: QboObjectKind;
  sourceId: string;
  /** AC4 of US-2997: it blocks THIS document, not the sync. */
  reason: string;
  unmappedCodes: string[];
}

const ENTITY: Record<QboObjectKind, string> = {
  sales_receipt: "salesreceipt",
  purchase: "purchase",
  deposit: "deposit",
};

const PREFIX: Record<QboObjectKind, string> = {
  sales_receipt: "GT-S",
  purchase: "GT-E",
  deposit: "GT-D",
};

/**
 * The stable external id, and the whole of AC5 rests on it.
 *
 * QuickBooks caps DocNumber at 21 characters, so a uuid does not fit. The
 * source id's first 16 hex digits do, and they are 64 bits of an already-random
 * v4 uuid: within one seller's books a collision is not a practical concern, and
 * the log's unique key would catch one anyway before a wrong document was
 * touched.
 *
 * DERIVED FROM THE SOURCE, NOT FROM A LEDGER ENTRY. rebuild_ledger_for_user()
 * deletes and re-inserts every entry, so an entry id changes on every rebuild
 * and a number built on one would create a fresh copy of the seller's entire
 * history the first time they rebuilt.
 */
export function docNumberFor(kind: QboObjectKind, sourceId: string): string {
  const hex = sourceId.replace(/-/g, "").slice(0, 16);
  return `${PREFIX[kind]}${hex}`;
}

/** FNV-1a over the canonical payload. Short, stable, and not a security claim. */
export function hashPayload(payload: unknown): string {
  const text = canonical(payload);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Key-sorted JSON, so a reordered object is not a "change". */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const obj = v as Record<string, unknown>;
  return `{${
    Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(",")
  }}`;
}

/** Cents to the decimal QuickBooks wants. Never float arithmetic on the way in. */
export function centsToAmount(cents: number): number {
  const sign = cents < 0 ? -1 : 1;
  const abs = Math.abs(Math.trunc(cents));
  return sign * Number(`${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`);
}

/**
 * Every account this document needs and does not have.
 *
 * A zero-amount line is not a requirement: it contributes nothing and demanding
 * a mapping for it would block a document over a line that would not appear.
 */
export function unmappedCodes(doc: PendingDocument, map: AccountMap): string[] {
  const missing = new Set<string>();
  for (const line of doc.lines) {
    if (line.amount_cents === 0) continue;
    if (!map[line.account_code]) missing.add(line.account_code);
  }
  return [...missing].sort();
}

export interface BuildOptions {
  /** Where a deposit lands. Required for deposits, ignored otherwise. */
  bankAccountId?: string;
  /** AC3: the sales this payout paid for, for the deposit's note. */
  payoutSales?: { sale_id: string; sale_date: string; title: string }[];
  /** Shown on the document so its origin is legible inside QuickBooks. */
  origin?: string;
}

export function buildDocument(
  doc: PendingDocument,
  map: AccountMap,
  opts: BuildOptions = {},
): BuiltDocument | BlockedDocument {
  const missing = unmappedCodes(doc, map);
  if (missing.length > 0) {
    return {
      kind: doc.object_kind,
      sourceId: doc.source_id,
      reason:
        `Waiting on ${missing.length} account${missing.length === 1 ? "" : "s"} ` +
        "you have not lined up with QuickBooks yet. Everything else still syncs.",
      unmappedCodes: missing,
    };
  }
  if (doc.object_kind === "deposit" && !opts.bankAccountId) {
    return {
      kind: doc.object_kind,
      sourceId: doc.source_id,
      reason:
        "A deposit needs a bank account in QuickBooks. Pick one for \"Money that " +
        "reached your bank\" and this will go.",
      unmappedCodes: ["cash_payout"],
    };
  }

  const docNumber = docNumberFor(doc.object_kind, doc.source_id);
  const payload = doc.object_kind === "sales_receipt"
    ? salesReceipt(doc, map, docNumber, opts)
    : doc.object_kind === "purchase"
    ? purchase(doc, map, docNumber, opts)
    : deposit(doc, map, docNumber, opts);

  return {
    kind: doc.object_kind,
    entity: ENTITY[doc.object_kind],
    docNumber,
    payload,
    payloadHash: hashPayload(payload),
  };
}

/**
 * A note that says where the document came from and, when there was any, what
 * was deliberately left out of it.
 *
 * The tax sentence is the one that earns its place: an accountant looking at a
 * $180 receipt against a 1099-K showing $194.87 needs to know the difference is
 * facilitator tax and not a missing sale.
 */
function note(doc: PendingDocument, opts: BuildOptions): string {
  const parts = [opts.origin ?? "Pushed from GradeThread. One way; edits here stay here."];
  if (doc.excluded_tax_cents !== 0) {
    parts.push(
      `Sales tax of ${
        centsToAmount(Math.abs(doc.excluded_tax_cents)).toFixed(2)
      } is NOT in this total: the marketplace collected it and paid it to the ` +
        "state, so it was never income. It IS inside the gross on the 1099-K.",
    );
  }
  return parts.join(" ");
}

/**
 * AC1 and AC4 in one document.
 *
 * Revenue and shipping income are positive lines; fees, the shipping label and
 * the cost of goods are NEGATIVE lines against their own accounts. That is the
 * shape that makes the receipt net to what actually arrived, so the deposit
 * reconciles against the bank line -- and it puts cost of goods ON THE SALE
 * rather than on the purchase, which is what keeps gross profit in QuickBooks
 * equal to gross profit here.
 */
function salesReceipt(
  doc: PendingDocument,
  map: AccountMap,
  docNumber: string,
  opts: BuildOptions,
): Record<string, unknown> {
  return {
    DocNumber: docNumber,
    TxnDate: doc.doc_date,
    PrivateNote: note(doc, opts),
    ...(doc.currency ? { CurrencyRef: { value: doc.currency } } : {}),
    Line: doc.lines
      .filter((l) => l.amount_cents !== 0)
      .map((l) => ({
        DetailType: "SalesItemLineDetail",
        Amount: centsToAmount(l.amount_cents),
        Description: l.memo ?? l.detail,
        SalesItemLineDetail: { ItemAccountRef: { value: map[l.account_code]! } },
      })),
  };
}

/** AC2. An operating expense against the account the seller mapped. */
function purchase(
  doc: PendingDocument,
  map: AccountMap,
  docNumber: string,
  opts: BuildOptions,
): Record<string, unknown> {
  return {
    DocNumber: docNumber,
    TxnDate: doc.doc_date,
    PaymentType: "Cash",
    PrivateNote: note(doc, opts),
    ...(doc.currency ? { CurrencyRef: { value: doc.currency } } : {}),
    // An expense is stored negative in the ledger and is positive on a
    // Purchase: QuickBooks already knows the direction from the document type,
    // and sending a negative here would book a refund.
    Line: doc.lines
      .filter((l) => l.amount_cents !== 0)
      .map((l) => ({
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: centsToAmount(Math.abs(l.amount_cents)),
        Description: l.memo ?? l.detail,
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: map[l.account_code]! },
        },
      })),
  };
}

/**
 * AC3. A deposit that names the sales it paid for.
 *
 * The names go in the note rather than in LinkedTxn: linking would require the
 * SalesReceipt ids, which means the deposit could only ever be pushed after
 * every one of its sales had succeeded -- so one failed sale would hold up the
 * deposit indefinitely. A note reconciles the bank line either way, and says
 * what it is short of when it is short.
 */
function deposit(
  doc: PendingDocument,
  map: AccountMap,
  docNumber: string,
  opts: BuildOptions,
): Record<string, unknown> {
  const sales = opts.payoutSales ?? [];
  const named = sales.slice(0, 20).map((s) => `${s.sale_date} ${s.title}`);
  const extra = sales.length > named.length ? ` and ${sales.length - named.length} more` : "";
  const detail = sales.length > 0
    ? ` Covers ${sales.length} sale${sales.length === 1 ? "" : "s"}: ${
      named.join("; ")
    }${extra}.`
    : " No sales are linked to this payout in GradeThread yet.";

  return {
    DocNumber: docNumber,
    TxnDate: doc.doc_date,
    PrivateNote: note(doc, opts) + detail,
    DepositToAccountRef: { value: opts.bankAccountId! },
    ...(doc.currency ? { CurrencyRef: { value: doc.currency } } : {}),
    Line: doc.lines
      .filter((l) => l.amount_cents !== 0)
      .map((l) => ({
        DetailType: "DepositLineDetail",
        Amount: centsToAmount(Math.abs(l.amount_cents)),
        Description: l.memo ?? l.detail,
        DepositLineDetail: { AccountRef: { value: map[l.account_code]! } },
      })),
  };
}

export function isBlocked(
  d: BuiltDocument | BlockedDocument,
): d is BlockedDocument {
  return "reason" in d;
}

/**
 * QuickBooks' own error text, pulled out of whatever shape it arrived in.
 *
 * AC6 asks for the QBO error, and its useful part is the Detail field, which
 * names the offending value. The rest of the envelope is noise, and a caller
 * who logs the whole body buries the one sentence that helps.
 */
export function qboErrorText(status: number, body: string): string {
  try {
    const json = JSON.parse(body) as {
      Fault?: { Error?: { Message?: string; Detail?: string; code?: string }[] };
    };
    const errs = json.Fault?.Error ?? [];
    if (errs.length > 0) {
      return errs
        .map((e) => [e.Message, e.Detail].filter(Boolean).join(" — "))
        .join(" | ")
        .slice(0, 900);
    }
  } catch {
    // Not JSON. An HTML error page from a proxy is still worth 300 characters
    // of, because "the response was HTML" is itself the diagnosis.
  }
  return `QuickBooks returned ${status}: ${body.slice(0, 300)}`;
}
