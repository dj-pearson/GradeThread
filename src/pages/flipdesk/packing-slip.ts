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

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString() : "—";
}

function line(label: string, value: string | null): string {
  if (value == null || value === "") return "";
  return `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`;
}

function slipHtml(row: PackingSlipRow): string {
  const certId = certificateIdFromUrl(row.certificateUrl);
  const grade =
    row.gradeValue != null
      ? `${row.gradeValue.toFixed(1)}${row.gradeLabel ? ` · ${row.gradeLabel}` : ""}`
      : null;
  return `<section class="slip" data-sale="${escapeHtml(row.id)}">
  <header>
    <h1>Packing slip</h1>
    <p class="order">${escapeHtml(row.orderRef ? `Order ${row.orderRef}` : "Manual sale")}</p>
  </header>
  <table>
    ${line("Item", row.title ?? "—")}
    ${line("SKU", row.sku)}
    ${line("Size", row.size)}
    ${line("Quantity", String(row.quantity ?? 1))}
    ${line("Location", row.locationBin)}
    ${line("Sold", fmtDate(row.soldAt))}
    ${line("Buyer", row.buyerUsername)}
    ${line("Condition grade", grade)}
    ${line("Certificate", certId)}
  </table>
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
 */
export function packingSlipDocument(rows: readonly PackingSlipRow[]): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Packing slips</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;margin:40px;color:#1A1A2E}
.slip{page-break-after:always;break-after:page;max-width:44rem}
.slip:last-child{page-break-after:auto;break-after:auto}
h1{color:#0F3460;font-size:20px;margin:0 0 2px}
.order{color:#666;margin:0 0 20px;font-size:13px}
table{width:100%;border-collapse:collapse}
th,td{padding:6px 10px;border-bottom:1px solid #e5e5e5;font-size:13px;text-align:left}
th{width:11rem;color:#555;font-weight:600}
.cert{margin-top:20px;font-size:12px;color:#0F3460}
.thanks{margin-top:28px;font-size:12px;color:#888}
@media print{body{margin:16px}}
</style></head><body>
${rows.map(slipHtml).join("\n")}
</body></html>`;
}
