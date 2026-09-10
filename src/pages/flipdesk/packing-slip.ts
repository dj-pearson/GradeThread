// US-3191: the sheet that goes in the box, built from rows already on screen.
//
// Printing goes through a popup document rather than a route, the same shape
// pnl.tsx already uses for the P&L statement. That is not only consistency: a
// route would take a sale id in the URL, and an id in a URL is a thing to
// authorize. This function is handed rows the seller's own tenant-scoped query
// already returned, so there is no id to check and no way to render a slip for
// somebody else's sale.
//
// ── WHAT IS DELIBERATELY NOT ON THE SLIP ────────────────────────────────────
//
// No buyer address, email or phone. The slip goes in a box that a courier, a
// sorting office and sometimes a returns handler all touch, and a packing slip
// is the wrong place to print a stranger's contact details — the shipping label
// already carries the address, once, where it is needed. Only buyer_username
// appears, which is what the seller uses to match a message to an order.
//
// The grade is on it when the item has one: a certificate id on the slip is the
// buyer's route to the condition report they were sold on, and it is the one
// thing on this sheet a competitor's packing slip cannot carry.

export interface PackingSlipRow {
  id: string;
  orderRef: string | null;
  soldAt: string | null;
  buyerUsername: string | null;
  title: string | null;
  sku: string | null;
  size: string | null;
  locationBin: string | null;
  /** US-3205's tote. Optional: it answers "which box" where the bin answers
   *  "which shelf", and a seller who totes by haul needs both to find one item. */
  container?: string | null;
  quantity: number | null;
  gradeValue: number | null;
  gradeLabel: string | null;
  certificateUrl: string | null;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The certificate id out of its URL, for a sheet nobody can click. */
export function certificateIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (trimmed === "") return null;
  const withoutQuery = trimmed.split(/[?#]/)[0] ?? trimmed;
  const tail = withoutQuery.replace(/\/+$/, "").split("/").pop();
  return tail && tail !== "" ? tail : null;
}

/**
 * The month in words, or null when there is no date to print.
 *
 * Not toLocaleDateString(): "9/1/2026" is 1 September to most of the world and
 * 9 January to the US, and this sheet is read by whoever opens the box, not by
 * the machine that rendered it. Null rather than a dash so the row disappears —
 * a packing slip with "Sold —" on it tells the buyer nothing and looks broken.
 */
function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function line(label: string, value: string | null): string {
  if (value == null || value === "") return "";
  return `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
}

/** Joins the parts that are actually present, so no slip reads "Size — · Qty 1". */
function joinParts(parts: (string | null)[]): string {
  return parts.filter((p): p is string => p != null && p !== "").join(" · ");
}

function slipHtml(row: PackingSlipRow): string {
  const certId = certificateIdFromUrl(row.certificateUrl);
  const grade =
    row.gradeValue != null
      ? `${row.gradeValue.toFixed(1)}${row.gradeLabel ? ` · ${row.gradeLabel}` : ""}`
      : null;

  // The garment is the headline. A seller holding six of these reads down the
  // left edge for the title and the shelf and nothing else, so those two are the
  // only things set larger than the body.
  const title = (row.title ?? "").trim() || "Garment";
  const meta = joinParts([
    row.size ? `Size ${row.size}` : null,
    `Qty ${row.quantity ?? 1}`,
    row.sku ? `SKU ${row.sku}` : null,
  ]);

  const bin = (row.locationBin ?? "").trim();
  const tote = (row.container ?? "").trim();
  const pick = joinParts([
    bin ? `Shelf <strong>${escapeHtml(bin)}</strong>` : null,
    tote ? `Tote <strong>${escapeHtml(tote)}</strong>` : null,
  ]);

  // Only the rows that have a value. An empty table element is left out of the
  // markup entirely rather than rendered as a bare rule across the sheet.
  const detail = [
    line("Sold", fmtDate(row.soldAt)),
    line("Buyer", row.buyerUsername),
    line("Condition grade", grade),
    line("Certificate", certId),
  ]
    .filter((r) => r !== "")
    .join("\n    ");

  return `<section class="slip" data-sale="${escapeHtml(row.id)}">
  <header>
    <span class="doc">Packing slip</span>
    <span class="order">${escapeHtml(row.orderRef ? `Order ${row.orderRef}` : "Manual sale")}</span>
  </header>
  <h1>${escapeHtml(title)}</h1>
  ${meta ? `<p class="meta">${escapeHtml(meta)}</p>` : ""}
  ${pick ? `<p class="pick">${pick}</p>` : ""}
  ${detail === "" ? "" : `<table>\n    ${detail}\n  </table>`}
  ${
    certId
      ? `<p class="cert">Check this garment's condition report at gradethread.com/verify using certificate ${escapeHtml(certId)}.</p>`
      : ""
  }
  <p class="thanks">Thank you for your order.</p>
</section>`;
}

/**
 * A complete printable document holding one slip per row, page-broken.
 *
 * Exported separately from the window handling so the markup can be asserted
 * without a DOM: the count of slips and the absence of buyer PII are both
 * properties worth a test.
 *
 * ── WHY THE PRINT CSS IS WHAT IT IS ─────────────────────────────────────────
 *
 * `@page{margin:14mm}` rather than nothing. With no @page rule the sheet margin
 * is whatever the browser defaults to that release, and Chrome and Firefox do
 * not agree, so the same slip lands in a different place depending on where the
 * seller printed it. 14mm clears the unprintable strip every consumer printer
 * has. The on-screen popup gets the same inset as body padding, which print
 * then zeroes so the two are not added together on paper.
 *
 * `break-inside:avoid` as well as `break-after:page`. The page break only
 * promises the NEXT slip starts on a fresh sheet; without this a long title
 * plus a long bin can still push the certificate line — the one line the buyer
 * is meant to act on — onto a sheet of its own.
 *
 * No filled backgrounds and no light-gray hairlines. Nothing on this sheet is
 * darker than the paper except type, so a slip costs one pass of black; and the
 * table rules are #999 rather than the #e5e5e5 a screen would use, because a
 * 1px near-white rule simply does not come out of an inkjet.
 */
export function packingSlipDocument(rows: readonly PackingSlipRow[]): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Packing slips</title>
<style>
/* Paper is the target, so every value here is chosen for ink and for a sheet
   edge, not for a screen. See packingSlipDocument's comment. */
:root{color-scheme:light}
@page{size:auto;margin:14mm}
body{font-family:Arial,Helvetica,sans-serif;margin:0;padding:14mm;background:#fff;color:#1A1A2E}
.slip{page-break-after:always;break-after:page;break-inside:avoid;page-break-inside:avoid;max-width:44rem}
.slip:last-child{page-break-after:auto;break-after:auto}
header{display:flex;justify-content:space-between;gap:16px;align-items:baseline;
  border-bottom:1px solid #333;padding-bottom:6px;margin-bottom:14px}
.doc{font-size:12px;color:#444}
.order{font-size:12px;color:#444}
h1{color:#0F3460;font-size:19px;line-height:1.25;margin:0}
.meta{margin:4px 0 0;font-size:13px;color:#444}
.pick{margin:14px 0 0;padding:8px 12px;border:1px solid #333;border-radius:6px;
  font-size:15px;color:#1A1A2E;display:inline-block}
.pick strong{font-weight:700}
table{width:100%;border-collapse:collapse;margin-top:18px}
th,td{padding:6px 10px;border-bottom:1px solid #999;font-size:13px;text-align:left}
th{width:11rem;color:#333;font-weight:600}
.cert{margin-top:18px;font-size:12px;color:#0F3460}
.thanks{margin-top:24px;font-size:12px;color:#444}
@media print{body{padding:0}}
</style></head><body>
${rows.map(slipHtml).join("\n")}
</body></html>`;
}
