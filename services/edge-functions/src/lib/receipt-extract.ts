import { getAnthropicClient, getLightweightModel } from "./ai-config.ts";
import { enterAiFeature } from "./ai-feature-context.ts";

// US-2993 — read a receipt.
//
// The model call and the PARSING are separate on purpose. Everything below
// `parseExtraction` is pure and unit-tested against real-looking model output,
// including the outputs that are wrong: a total with a currency symbol, a date
// in the wrong century, a confidence of 1.0 on a field the model invented.
// Testing only the happy path here would test the prompt rather than the code.

/**
 * The prompt version, recorded on every row it produces (AC6).
 *
 * BUMP THIS WHENEVER THE PROMPT TEXT CHANGES. A bad release has to be traceable
 * to the entries it made, and the only alternative is guessing at dates.
 */
export const RECEIPT_PROMPT_VERSION = "receipt-v1";

/** Accounts the model may suggest. Kept short: it is a hint, not a decision. */
const SUGGESTABLE_CATEGORIES = [
  "shipping_supplies",
  "subscriptions",
  "platform_fees",
  "sourcing_travel",
  "equipment",
  "storage",
  "other",
] as const;

export type SuggestedCategory = (typeof SUGGESTABLE_CATEGORIES)[number];

/**
 * One line off the receipt.
 *
 * Thrift receipts describe things uselessly -- "MENS SHIRT", "RED ITEM",
 * "CLOTHING 2.99" -- so a line's `description` is NOT expected to identify
 * anything on its own. It is captured because the PRICES are the useful part:
 * a receipt with six lines totalling $47.83 can have its cost split across the
 * six items sourced that day, which is what turns a vague receipt into six real
 * cost bases. The matching itself is US-3012.
 */
export interface ReceiptLine {
  description: string | null;
  amount_cents: number;
}

export interface ReceiptDraft {
  vendor: string | null;
  /** yyyy-mm-dd, or null when the model could not read one. */
  spent_on: string | null;
  /** Integer cents. Null when unreadable -- never 0, which is a real amount. */
  total_cents: number | null;
  tax_cents: number | null;
  category: SuggestedCategory | null;
  /** Individual lines, cheapest signal for splitting a total across items. */
  lines: ReceiptLine[];
}

export interface ReceiptExtraction {
  draft: ReceiptDraft;
  /** Per field, 0 to 1. Missing key means the model said nothing about it. */
  confidence: Record<string, number>;
  promptVersion: string;
  /** Set when the model answered but the answer was unusable. */
  warning: string | null;
}

const PROMPT = `You are reading a photograph of a purchase receipt for a US clothing reseller's bookkeeping.

Return ONLY a JSON object, no prose, with exactly these keys:
{
  "vendor": string or null,
  "date": "YYYY-MM-DD" or null,
  "total": number or null,
  "tax": number or null,
  "category": one of ${SUGGESTABLE_CATEGORIES.map((c) => `"${c}"`).join(", ")} or null,
  "lines": [ { "description": string or null, "amount": number } ],
  "confidence": { "vendor": 0-1, "date": 0-1, "total": 0-1, "tax": 0-1, "category": 0-1 }
}

Rules:
- "total" is the FINAL amount paid, including tax. Not the subtotal.
- "tax" is the sales tax line if one is printed. If no tax line is printed, return null, NOT 0.
- Return null for anything you cannot actually read. Do not guess.
- Confidence must reflect what you can SEE. If a field is null, its confidence is 0.
- If the image is not a receipt at all, return every field null with confidence 0.
- Amounts are plain numbers in dollars: 12.34, not "$12.34".
- "lines" is every priced line on the receipt, in the order printed. Copy the description EXACTLY as printed even when it is useless ("MENS SHIRT", "RED ITEM") -- the price is what matters, and a tidied-up description is a guess. Omit subtotal, tax and total lines. Return [] if you cannot read individual lines.`;

/**
 * A dollar figure from the model to integer cents.
 *
 * Accepts a number or a string, because models return both however firmly the
 * prompt asks. Rejects anything that is not a finite non-negative amount --
 * a receipt total of -5 or 1e9 is a misread, not a purchase, and letting it
 * through puts a wrong number in front of a seller with a confident label on it.
 */
export function toCents(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const raw =
    typeof value === "number" ? value : Number(String(value).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(raw)) return null;
  if (raw < 0) return null;
  // A receipt over $100,000 is a misread of a barcode or an order number.
  if (raw > 100000) return null;
  return Math.round(raw * 100);
}

/**
 * A date from the model, or null.
 *
 * Only accepts YYYY-MM-DD, and only within a plausible window. A receipt dated
 * 1998 or 2087 is an OCR error on a till number, and passing it through would
 * put the expense in a tax year the seller was not trading in.
 */
export function toDate(value: unknown, today: Date): string | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const thisYear = today.getFullYear();
  // Ten years back covers amending an old return; one year forward covers a
  // clock skew or a receipt printed just after midnight on New Year.
  if (year < thisYear - 10 || year > thisYear + 1) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** 0 to 1, or 0. A model that omits confidence gets no benefit of the doubt. */
export function toConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Parse the model's reply.
 *
 * Never throws. Every failure mode returns a draft of nulls plus a warning the
 * screen shows, because AC2 requires a failed extraction to degrade to the
 * manual form SAYING SO -- a spinner that ends in an empty form teaches the
 * seller the feature is broken.
 */
export function parseExtraction(
  text: string,
  today: Date = new Date(),
): ReceiptExtraction {
  const empty: ReceiptDraft = {
    vendor: null,
    spent_on: null,
    total_cents: null,
    tax_cents: null,
    category: null,
    lines: [],
  };
  const fail = (warning: string): ReceiptExtraction => ({
    draft: empty,
    confidence: {},
    promptVersion: RECEIPT_PROMPT_VERSION,
    warning,
  });

  // Models wrap JSON in prose or fences however firmly the prompt asks not to.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return fail("We could not read that as a receipt.");
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return fail("We could not read that as a receipt.");
  }

  const conf = (raw.confidence ?? {}) as Record<string, unknown>;
  const vendorRaw = typeof raw.vendor === "string" ? raw.vendor.trim() : "";
  const categoryRaw = typeof raw.category === "string" ? raw.category : "";

  const draft: ReceiptDraft = {
    // A vendor longer than a shop name is the model narrating. Trim rather than
    // reject: the first line is usually right.
    vendor: vendorRaw === "" ? null : vendorRaw.slice(0, 120),
    spent_on: toDate(raw.date, today),
    total_cents: toCents(raw.total),
    tax_cents: toCents(raw.tax),
    category: (SUGGESTABLE_CATEGORIES as readonly string[]).includes(categoryRaw)
      ? (categoryRaw as SuggestedCategory)
      : null,
    lines: parseLines(raw.lines),
  };

  const confidence: Record<string, number> = {};
  for (const key of ["vendor", "date", "total", "tax", "category"]) {
    confidence[key] = toConfidence(conf[key]);
  }

  // A field the model could not produce cannot be confident about it, whatever
  // it claimed. This is the guard against the specific failure where a model
  // returns null and 1.0 together.
  if (draft.vendor === null) confidence.vendor = 0;
  if (draft.spent_on === null) confidence.date = 0;
  if (draft.total_cents === null) confidence.total = 0;
  if (draft.tax_cents === null) confidence.tax = 0;
  if (draft.category === null) confidence.category = 0;

  // The total is the only field the expense cannot be created without.
  const warning =
    draft.total_cents === null
      ? "We could not read a total on that. Type it in and the receipt still gets saved."
      : null;

  return {
    draft,
    confidence,
    promptVersion: RECEIPT_PROMPT_VERSION,
    warning,
  };
}

/**
 * The priced lines, or an empty list.
 *
 * A line with no readable amount is DROPPED rather than zeroed: a $0.00 line
 * would sit in a split looking like a free item and silently take a share of
 * nothing. Capped at 60 because a receipt with more lines than that is a till
 * roll the model is hallucinating its way down.
 */
export function parseLines(value: unknown): ReceiptLine[] {
  if (!Array.isArray(value)) return [];
  const out: ReceiptLine[] = [];
  for (const entry of value.slice(0, 60)) {
    if (typeof entry !== "object" || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const cents = toCents(row.amount);
    if (cents === null || cents <= 0) continue;
    const desc =
      typeof row.description === "string" && row.description.trim() !== ""
        ? row.description.trim().slice(0, 120)
        : null;
    out.push({ description: desc, amount_cents: cents });
  }
  return out;
}

/**
 * Do the lines add up to the total?
 *
 * Returns the gap in cents, or null when either side is unknown. A receipt
 * whose lines miss the total by more than the tax is one the model read
 * partially, and a split built on it would allocate the wrong cost to every
 * item -- so the caller can offer the split or not on the strength of this.
 */
export function linesReconcile(draft: ReceiptDraft): number | null {
  if (draft.total_cents === null || draft.lines.length === 0) return null;
  const sum = draft.lines.reduce((s, l) => s + l.amount_cents, 0);
  return draft.total_cents - (draft.tax_cents ?? 0) - sum;
}

/**
 * Fields worth flagging to the seller (AC3).
 *
 * 0.75 matches the grading pipeline's human-review threshold, deliberately: two
 * different numbers for "not sure enough" in one product is one number nobody
 * can explain.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.75;

export function lowConfidenceFields(
  extraction: ReceiptExtraction,
): string[] {
  const out: string[] = [];
  const fieldFor: Record<string, unknown> = {
    vendor: extraction.draft.vendor,
    date: extraction.draft.spent_on,
    total: extraction.draft.total_cents,
    tax: extraction.draft.tax_cents,
    category: extraction.draft.category,
  };
  for (const [key, conf] of Object.entries(extraction.confidence)) {
    // A field the model produced NOTHING for is absent, not uncertain. It shows
    // as an empty input, which already says everything a warning would.
    if (fieldFor[key] === null || fieldFor[key] === undefined) continue;
    if (conf < LOW_CONFIDENCE_THRESHOLD) out.push(key);
  }
  return out;
}

/**
 * Bytes to base64, in chunks.
 *
 * The obvious `for (const b of bytes) s += String.fromCharCode(b)` is what the
 * rest of this codebase uses, and it is fine for a signature. A receipt is up to
 * ten megabytes, where that loop builds a ten-million-character string one
 * concatenation at a time. `String.fromCharCode(...chunk)` with a chunk this
 * size stays well under the argument limit that makes the spread version throw
 * on large inputs.
 */
export function encodeBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Call the model. Kept thin so the parsing above can be tested without it. */
export async function extractReceipt(
  imageBase64: string,
  mediaType: "image/jpeg" | "image/png" | "image/webp",
  userId: string,
): Promise<ReceiptExtraction> {
  // AC5: attributes the spend to this feature and this user. The limiter
  // wrapper in ai-config.ts records model, tokens, latency and cost to
  // ai_usage_events from here, so it shows up in admin-ai-spend without any
  // per-call bookkeeping.
  enterAiFeature("receipt-extract", userId);

  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: getLightweightModel(),
    max_tokens: 600,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: imageBase64 },
          },
          { type: "text", text: PROMPT },
        ],
      },
    ],
  });

  // Narrowed by checking the discriminant inline rather than with a hand-written
  // predicate: the SDK's TextBlock carries more than {type, text}, so a
  // predicate stops compiling every time the SDK adds a field.
  const text = response.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter((t) => t !== "")
    .join("\n");

  return parseExtraction(text);
}
