// US-1126: verified-seller credential block for listing descriptions (PURE).
//
// A publicly-verified seller's accumulated, independently-certified grades are
// the trust signal that differentiates them from a plain marketplace seller.
// This module turns that signal into a buyer-facing block (total graded, average
// grade, a link to the public /verified/<handle> profile) that AutoLister embeds
// into the listing / cross-listing description.
//
// PURE (no I/O) so it's unit-tested directly; the impure loader that enforces
// eligibility + pulls the stats lives in seller-credentials-job.ts. No PII beyond
// what already lives on the PUBLIC verified profile (handle, display name,
// aggregate grade stats) is ever emitted.

export const DEFAULT_SITE = "https://gradethread.com";

export interface SellerCredentialStats {
  total_graded: number;
  average_grade: number;
}

export interface SellerCredential {
  handle: string;
  display_name: string | null;
  stats: SellerCredentialStats;
}

export interface SellerCredentialBlock {
  plain: string;
  markdown: string;
  html: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Pure: render the verified-seller credential block in plain/markdown/html. The
 * stats line is only shown when the seller has at least one certified grade; the
 * verified badge + profile link always appear (the caller has already confirmed
 * the seller is publicly verified and opted in). No I/O — unit-tested.
 */
export function buildSellerCredentialBlock(
  cred: SellerCredential,
  siteUrl: string = DEFAULT_SITE,
): SellerCredentialBlock {
  const site = siteUrl || DEFAULT_SITE;
  const profileUrl = `${site}/verified/${cred.handle}`;
  const name = cred.display_name?.trim() || cred.handle;
  const { total_graded, average_grade } = cred.stats;
  const hasStats = total_graded > 0;
  const avg = average_grade.toFixed(1);
  const gradedLabel = `${total_graded} ${total_graded === 1 ? "item" : "items"}`;

  // ── Plain text ──────────────────────────────────────────────────
  const plainLines: string[] = [];
  plainLines.push("GradeThread Verified Seller");
  plainLines.push(name);
  if (hasStats) {
    plainLines.push(
      `${gradedLabel} independently graded • Average condition grade ${avg} / 10`,
    );
  }
  plainLines.push(`See every verified grade: ${profileUrl}`);
  const plain = plainLines.join("\n");

  // ── Markdown ────────────────────────────────────────────────────
  const mdLines: string[] = [];
  mdLines.push(`**GradeThread Verified Seller — ${name}**`);
  if (hasStats) {
    mdLines.push(
      `${gradedLabel} independently graded · **${avg} / 10** average condition grade`,
    );
  }
  mdLines.push(`[See every verified grade ↗](${profileUrl})`);
  const markdown = mdLines.join("\n\n");

  // ── HTML (for listing descriptions that render HTML, e.g. eBay) ──
  const htmlParts: string[] = [];
  htmlParts.push(
    `<div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;font:14px/1.5 system-ui,sans-serif">`,
  );
  htmlParts.push(
    `<div style="font-weight:700;color:#0F3460;margin-bottom:6px">✓ GradeThread Verified Seller — ${escapeHtml(name)}</div>`,
  );
  if (hasStats) {
    htmlParts.push(
      `<div style="margin-bottom:8px">${escapeHtml(gradedLabel)} independently graded · <strong>${escapeHtml(avg)} / 10</strong> average condition grade</div>`,
    );
  }
  htmlParts.push(
    `<a href="${escapeHtml(profileUrl)}" style="color:#0F3460;font-weight:600;text-decoration:none">See every verified grade ↗</a>`,
  );
  htmlParts.push(`</div>`);
  const html = htmlParts.join("");

  return { plain, markdown, html };
}
