// US-1846: the buyer platform's personal-data register.
//
// Every buyer feature that shipped between US-1798 and US-1845 created its own
// table, and each one was individually careful — RLS on, owner-scoped policy,
// ON DELETE CASCADE to users. What nobody owned was the SET. Two obligations
// only make sense against the whole set, and both were silently unmet:
//
//   • ACCESS (GDPR Art. 15 / CCPA "right to know"). GET /api/account/export
//     enumerated seller tables by hand. A buyer who exported their account got
//     a file with no body measurements, no closet, no saved searches, no
//     watchlist, no reward ledger, no guarantee claims — and no indication that
//     anything was missing. A subject-access response that LOOKS complete and
//     is not is worse than a failed one (the same argument export-stream.ts
//     makes about truncation).
//   • CLASSIFICATION. "Buyer PII is classified sensitive" is not a property of
//     any one migration comment; it is a property of a list, and there was no
//     list.
//
// So this module IS the list, and it is the thing the export route iterates —
// not a document beside the code that can drift from it. A buyer table added
// without an entry here fails buyer-pii_test.ts, which discovers buyer-domain
// tables straight out of supabase/migrations/ rather than trusting this file to
// be complete.
//
// Erasure needs no parallel structure — POST /api/account/delete already
// destroys these through the auth.users cascade — but it does need CHECKING,
// so each entry declares which of the two shapes it has and the test asserts
// the migration matches. A table that says `cascade` and is actually keyed
// ON DELETE SET NULL survives erasure with its data intact, which is exactly
// how the email-keyed tables in US-2005 stayed queryable after {deleted:true}.

/**
 * How closely a table's rows describe the person rather than their activity.
 *
 * `sensitive` is not a GDPR Art. 9 special category — we hold none of those.
 * It marks data whose exposure harms the subject directly rather than
 * commercially: their body, and what they were shopping for and when.
 */
export type BuyerPiiClassification = "sensitive" | "personal";

/**
 * What account deletion does to the row.
 *
 * `cascade` — the row is destroyed with the account (the default, and what
 *   almost everything here is).
 * `unlink`  — the subject reference is set to NULL and the row survives
 *   de-identified. Only correct where the row is also somebody else's record
 *   or platform-wide evidence; it must be argued per entry, never assumed.
 */
export type BuyerPiiErasure = "cascade" | "unlink";

export interface BuyerPiiTable {
  /** public.<table> */
  table: string;
  /** The column that scopes a row to its data subject. */
  scopeColumn: string;
  classification: BuyerPiiClassification;
  erasure: BuyerPiiErasure;
  /** What the rows hold, in the words the privacy policy uses. */
  what: string;
  /** The key this table appears under in the export document. */
  exportKey: string;
  /** The migration that creates it — the RLS/cascade guard reads this file. */
  migration: string;
}

/**
 * Every table holding buyer personal data, keyed to the subject.
 *
 * Ordered by how close the data sits to the person: body first, then what they
 * own and shop for, then the account machinery around it.
 */
export const BUYER_PII_TABLES: readonly BuyerPiiTable[] = [
  {
    table: "body_profiles",
    scopeColumn: "user_id",
    classification: "sensitive",
    erasure: "cascade",
    what: "Body measurements and fit preferences used for fit predictions.",
    exportKey: "body_profiles",
    migration: "00407_body_profiles.sql",
  },
  {
    table: "ingested_listings",
    scopeColumn: "user_id",
    classification: "sensitive",
    erasure: "cascade",
    what:
      "Marketplace listings you asked the extension to check, with our grade — a record of what you were shopping for.",
    exportKey: "ingested_listings",
    migration: "00535_ingested_listings.sql",
  },
  {
    table: "buyer_preferences",
    scopeColumn: "user_id",
    classification: "personal",
    erasure: "cascade",
    what: "Brands, categories, sizes, price range and alert cadence you set.",
    exportKey: "buyer_preferences",
    migration: "00411_buyer_preferences.sql",
  },
  {
    table: "closet_items",
    scopeColumn: "user_id",
    classification: "personal",
    erasure: "cascade",
    what: "Items in your closet/portfolio, including ones you entered manually.",
    exportKey: "closet_items",
    migration: "00420_closet_items.sql",
  },
  {
    table: "closet_item_valuations",
    scopeColumn: "user_id",
    classification: "personal",
    erasure: "cascade",
    what: "Our current value estimate for each closet item.",
    exportKey: "closet_item_valuations",
    migration: "00428_closet_item_valuations.sql",
  },
  {
    table: "buyer_purchases",
    scopeColumn: "user_id",
    classification: "personal",
    erasure: "cascade",
    what: "Purchases you linked to a certificate, with what you paid.",
    exportKey: "buyer_purchases",
    migration: "00418_buyer_purchases.sql",
  },
  {
    table: "purchase_arrival_captures",
    scopeColumn: "user_id",
    classification: "personal",
    erasure: "cascade",
    what: "Arrival photos and condition captures for a linked purchase.",
    exportKey: "purchase_arrival_captures",
    migration: "00418_buyer_purchases.sql",
  },
  {
    table: "purchase_coverage",
    scopeColumn: "user_id",
    classification: "personal",
    erasure: "cascade",
    what: "The guarantee terms frozen against each purchase at the time you linked it.",
    exportKey: "purchase_coverage",
    migration: "00419_purchase_coverage.sql",
  },
  {
    table: "buyer_guarantee_claims",
    scopeColumn: "user_id",
    classification: "personal",
    erasure: "cascade",
    what: "Guarantee claims you filed and how they were decided.",
    exportKey: "buyer_guarantee_claims",
    migration: "00424_buyer_guarantee_claims.sql",
  },
  {
    table: "saved_searches",
    scopeColumn: "user_id",
    classification: "personal",
    erasure: "cascade",
    what: "Your condition-alert criteria.",
    exportKey: "saved_searches",
    migration: "00416_alerts_watchlist.sql",
  },
  {
    table: "watchlist_items",
    scopeColumn: "user_id",
    classification: "personal",
    erasure: "cascade",
    what: "Items you are watching.",
    exportKey: "watchlist_items",
    migration: "00416_alerts_watchlist.sql",
  },
  {
    table: "buyer_wants",
    scopeColumn: "user_id",
    classification: "personal",
    erasure: "cascade",
    what: "Want-list entries describing items you are hunting for.",
    exportKey: "buyer_wants",
    migration: "00431_buyer_wants.sql",
  },
  {
    // Not keyed on user_id — a match row has a buyer side and a seller side,
    // and the buyer is the subject here.
    table: "want_matches",
    scopeColumn: "buyer_user_id",
    classification: "personal",
    erasure: "cascade",
    what: "Sellers surfaced to you against a want-list entry.",
    exportKey: "want_matches",
    migration: "00431_buyer_wants.sql",
  },
  {
    table: "buyer_trust_scores",
    scopeColumn: "user_id",
    classification: "personal",
    erasure: "cascade",
    what: "Your Trust Score, level, and the event count behind it.",
    exportKey: "buyer_trust_scores",
    migration: "00417_buyer_trust_score.sql",
  },
  {
    table: "buyer_reward_ledger",
    scopeColumn: "user_id",
    classification: "personal",
    erasure: "cascade",
    what: "Reward credits you earned, redeemed, or had reversed.",
    exportKey: "buyer_reward_ledger",
    migration: "00422_buyer_reward_ledger.sql",
  },
  {
    table: "buyer_reward_credits",
    scopeColumn: "user_id",
    classification: "personal",
    erasure: "cascade",
    what: "Your current reward-credit balance.",
    exportKey: "buyer_reward_credits",
    migration: "00422_buyer_reward_ledger.sql",
  },
  {
    table: "buyer_meter_usage",
    scopeColumn: "user_id",
    classification: "personal",
    erasure: "cascade",
    what: "How much of each monthly buyer allowance you have used this period.",
    exportKey: "buyer_meter_usage",
    migration: "00413_buyer_metering.sql",
  },
  {
    table: "buyer_notification_log",
    scopeColumn: "user_id",
    classification: "personal",
    erasure: "cascade",
    what: "Which buyer alerts we sent you and when.",
    exportKey: "buyer_notification_log",
    migration: "00412_buyer_notifications.sql",
  },
  {
    // The one `unlink`, and the reason the field exists. A grade outcome is a
    // measurement of OUR grade against what arrived — platform accuracy
    // evidence that also feeds the seller's integrity record, so it is not
    // solely the buyer's row to destroy. 00421 keys the buyer side
    // ON DELETE SET NULL: erasure severs the buyer from it and the
    // de-identified measurement remains. Exported all the same, because while
    // the account exists these ARE the buyer's confirmations.
    table: "grade_outcomes",
    scopeColumn: "buyer_user_id",
    classification: "personal",
    erasure: "unlink",
    what: "Grade confirmations you submitted after an item arrived.",
    exportKey: "buyer_grade_confirmations",
    // 00036 creates the table; 00421 is where the BUYER side of it — the
    // scope column, its FK action and the buyer read policy — is defined.
    migration: "00421_buyer_grade_confirmations.sql",
  },
];

/** The subset at a given classification — the privacy page groups by this. */
export function buyerPiiTablesOf(
  classification: BuyerPiiClassification,
): readonly BuyerPiiTable[] {
  return BUYER_PII_TABLES.filter((t) => t.classification === classification);
}
