// Decoded App Store payload shapes — the subset of Apple's
// JWSTransactionDecodedPayload / JWSRenewalInfoDecodedPayload our reconciler
// uses. The crypto/verify boundary (verify.ts) produces these; the pure
// reconcilers consume them, so they're testable with plain fixture JSON.

export interface DecodedTransactionLite {
  productId: string;
  originalTransactionId: string;
  transactionId: string;
  /** Subscription expiry, epoch milliseconds. Absent for consumables. */
  expiresDate?: number | null;
  /** UUID we set at purchase = users.id, so notifications map back to the user. */
  appAccountToken?: string | null;
  /** "Sandbox" | "Production". */
  environment?: string | null;
  /**
   * Refund/revoke timestamp (epoch ms) — set by Apple once a transaction has
   * been refunded or family-revoked. Present on REFUND/REVOKE notifications and
   * on a re-presented already-refunded transaction. Non-null ⇒ the transaction
   * must NOT entitle (grant credits / a plan). US-1615 / C2.
   */
  revocationDate?: number | null;
}

export interface DecodedRenewalLite {
  /** 1 = auto-renew on, 0 = off. */
  autoRenewStatus?: number | null;
}
