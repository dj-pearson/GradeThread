// Channel-safe "proof of grade" copy for the Affiliate tab.
//
// The one rule: a marketplace listing never carries a link. eBay hides a
// listing whose description links off eBay (FlipDesk's publish path strips
// exactly these links, see stripCertLinks in flipdesk-ebay-shared.ts), and
// Poshmark, Depop and Mercari take no HTML at all. So the marketplace lines
// are plain text naming the certificate NUMBER, which a buyer can look up
// themselves; only the seller's own site gets the linked badge.
//
// Dependency-free on purpose: the edge suite imports this file to prove
// stripCertLinks leaves these lines untouched.

export type ProofChannel = "ebay" | "marketplace" | "site";

export const PROOF_CHANNELS: ReadonlyArray<{ value: ProofChannel; label: string }> = [
  { value: "ebay", label: "eBay" },
  { value: "marketplace", label: "Other marketplaces" },
  { value: "site", label: "Your site and social" },
];

/** The line FlipDesk writes into an eBay description, with placeholders. */
export const EBAY_PROOF_LINE =
  "Graded by GradeThread. Condition Grade [grade]. Cert #[cert number].";

/** Plain text for Poshmark, Depop, Mercari and anything else without HTML. */
export const MARKETPLACE_PROOF_LINE =
  "Condition graded by GradeThread: [grade] out of 10. Cert #[cert number]. " +
  "Search the cert number on GradeThread to see the full report.";

/**
 * Copy-paste HTML badge for the seller's own site or blog. Links to their
 * referral link. ASCII only: the check mark is an entity, so the snippet
 * survives any editor or encoding it is pasted through.
 */
export function siteBadgeHtml(href: string): string {
  const safe = href.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return [
    `<a href="${safe}" target="_blank" rel="noopener"`,
    `   style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;`,
    `          border-radius:9999px;background:#0F3460;color:#fff;font:600 13px/1 Inter,Arial,sans-serif;`,
    `          text-decoration:none;">`,
    `  &#10003; Graded by GradeThread`,
    `</a>`,
  ].join("\n");
}
