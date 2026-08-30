import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { downloadZip } from "client-zip";
import { AlertTriangle, FileArchive, Printer } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { toastError } from "@/lib/toast-error";
import { downloadBlob } from "@/lib/download";
import { escapeHtml } from "@/lib/escape-html";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatCents } from "@/lib/ledger-math";
import { ensureLedgerBuilt, fetchLedgerEntries } from "@/lib/ledger";
import { buildStatement } from "@/lib/pnl-statement";
import { fetchCogsWorksheet } from "@/lib/cogs";
import { fetchBridge, fetchPlatformsWithSales } from "@/lib/form-1099k";
import { fetchMileageSummary, fetchVehicleYear } from "@/lib/mileage";
import { fetchHomeOfficeRate, fetchHomeOfficeYear, homeOfficeDeductionCents } from "@/lib/home-office";
import { fetchReviewQueue } from "@/lib/books-review";
import { expenseReceiptUrl } from "@/lib/expense-receipts";
import {
  TAX_PROFILE_DEFAULTS,
  fetchTaxProfile,
  fiscalYearLabel,
} from "@/lib/tax-profile";
import {
  PACKET_EXCLUSIONS,
  buildPacketCsv,
  packetWarnings,
  scheduleCRows,
  type PacketInput,
} from "@/lib/tax-packet";

// US-2996 — the year-end tax packet.
//
// AC3 SAYS THE EVIDENCE LINKS MUST OUTLIVE THE 900-SECOND SIGNED URL. They
// cannot: the receipts bucket is private and US-276 caps a signed URL at 900s,
// with a test that fails closed on anything longer. So the packet does not
// contain links at all -- it contains the RECEIPT FILES, fetched at build time
// and zipped in. A file in a folder outlives any URL, which is what the
// requirement was actually asking for.

interface ReceiptRow {
  id: string;
  description: string | null;
  spent_on: string;
  amount: number;
  receipt_path: string | null;
}

export function TaxPacketCard() {
  const user = useAuthStore((s) => s.user);
  const [year, setYear] = useState(() => new Date().getFullYear() - 1);
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState("");

  const { data: profile } = useQuery({
    queryKey: ["tax-profile", user?.id],
    enabled: !!user,
    queryFn: fetchTaxProfile,
    staleTime: 30 * 60 * 1000,
  });
  const fyStart =
    profile?.fiscal_year_start_month ??
    TAX_PROFILE_DEFAULTS.fiscal_year_start_month;

  const from = `${year}-${String(fyStart).padStart(2, "0")}-01`;
  const to = `${year + 1}-${String(fyStart).padStart(2, "0")}-01`;
  const label = fiscalYearLabel(new Date(year, fyStart - 1, 1), fyStart);

  async function gather(): Promise<PacketInput> {
    setProgress("Reading your books");
    await ensureLedgerBuilt();
    const entries = await fetchLedgerEntries(from, to);
    const statement = buildStatement(
      entries.map((e) => ({
        account: e.ledger_accounts?.code ?? "__missing",
        amount_cents: e.amount_cents,
      })),
    );

    setProgress("Working out cost of goods sold");
    const cogs = await fetchCogsWorksheet(from, to).catch(() => null);

    setProgress("Checking your 1099-Ks");
    const platforms = await fetchPlatformsWithSales(year).catch(() => []);
    const bridges = [];
    for (const p of platforms) {
      const b = await fetchBridge(p.platform, year).catch(() => null);
      if (b) bridges.push(b);
    }

    setProgress("Adding mileage and the home office");
    const mileage = await fetchMileageSummary(
      `${year}-01-01`,
      `${year + 1}-01-01`,
    ).catch(() => null);
    const vehicleYear = await fetchVehicleYear(year).catch(() => null);
    const homeOffice = await fetchHomeOfficeYear(year).catch(() => null);
    const rate = await fetchHomeOfficeRate().catch(() => null);
    const homeOfficeCents =
      homeOffice && rate && homeOffice.method === "simplified"
        ? homeOfficeDeductionCents(
            homeOffice.square_feet,
            homeOffice.months_used,
            rate,
          )
        : 0;

    setProgress("Checking what still needs a look");
    const reviewIssues = await fetchReviewQueue(from, to).catch(() => []);

    const { data: snapRow } = await supabase
      .from("inventory_snapshots")
      .select("total_cost_cents, item_count, items_without_cost, reconstructed")
      .eq("as_of", to)
      .maybeSingle();
    const snap = snapRow as {
      total_cost_cents: number;
      item_count: number;
      items_without_cost: number;
      reconstructed: boolean;
    } | null;

    const { data: expenseRows } = await supabase
      .from("flipdesk_expenses")
      .select("id, description, spent_on, amount, receipt_path")
      .gte("spent_on", from)
      .lt("spent_on", to);
    const expenses = (expenseRows ?? []) as ReceiptRow[];

    return {
      taxYear: label,
      from,
      to,
      accountingMethod: profile?.accounting_method ?? "cash",
      entityType: profile?.entity_type ?? "sole_prop",
      filingStatus: profile?.filing_status ?? "single",
      hasEin: profile?.has_ein ?? false,
      statement,
      cogs,
      bridges,
      mileage,
      vehicleYear,
      homeOfficeCents,
      homeOfficeSquareFeet: homeOffice?.square_feet ?? null,
      homeOfficeMonths: homeOffice?.months_used ?? null,
      snapshotTotalCents: snap?.total_cost_cents ?? null,
      snapshotItemCount: snap?.item_count ?? null,
      snapshotReconstructed: snap?.reconstructed ?? false,
      snapshotItemsWithoutCost: snap?.items_without_cost ?? 0,
      reviewIssues,
      receiptCount: expenses.filter((e) => e.receipt_path).length,
      expensesWithoutReceipt: expenses.filter(
        (e) => !e.receipt_path && e.amount >= 75,
      ).length,
    };
  }

  async function build() {
    if (!user) return;
    setBuilding(true);
    try {
      const input = await gather();
      const warnings = packetWarnings(input);

      // AC6: warn, then produce it anyway. A partial packet delivered beats a
      // perfect one blocked -- the accountant is waiting, and the caveats are
      // on the cover.
      if (warnings.length > 0) {
        toast.warning(
          `${warnings.length} thing${warnings.length === 1 ? "" : "s"} to flag. They are on the cover page.`,
        );
      }

      const files: { name: string; input: Blob | string; lastModified?: Date }[] = [];
      files.push({ name: `${label}/tax-packet-${label}.csv`, input: buildPacketCsv(input) });
      files.push({ name: `${label}/tax-packet-${label}.html`, input: buildPacketHtml(input) });

      // AC3. The RECEIPT FILES, not links to them. A signed URL is capped at
      // 900 seconds and would be dead before the accountant opened the folder.
      setProgress("Collecting receipts");
      const { data: withReceipts } = await supabase
        .from("flipdesk_expenses")
        .select("id, description, spent_on, amount, receipt_path")
        .gte("spent_on", from)
        .lt("spent_on", to)
        .not("receipt_path", "is", null);

      let fetched = 0;
      for (const row of (withReceipts ?? []) as ReceiptRow[]) {
        try {
          // A fresh signed URL per receipt, used immediately. It expires in
          // 900 seconds, which is why the BYTES go in the zip and the URL never
          // leaves this function.
          const url = await expenseReceiptUrl(row.id);
          const res = await fetch(url);
          if (!res.ok) continue;
          const blob = await res.blob();
          const ext = (blob.type || "image/jpeg").split("/")[1] ?? "jpg";
          const safe = (row.description ?? "expense")
            .replace(/[^a-z0-9]+/gi, "-")
            .slice(0, 40);
          files.push({
            name: `${label}/receipts/${row.spent_on}_${safe}_${row.amount.toFixed(2)}.${ext === "jpeg" ? "jpg" : ext}`,
            input: blob,
          });
          fetched++;
        } catch {
          // One unreadable receipt must not lose the packet. The cover already
          // says how many were expected, so a shortfall is visible.
        }
      }

      setProgress("Zipping it up");
      const blob = await downloadZip(files).blob();
      downloadBlob(blob, `tax-packet-${label}.zip`);
      toast.success(
        `Packet ready. ${fetched} receipt${fetched === 1 ? "" : "s"} included.`,
      );
    } catch (err) {
      toastError(err, "Couldn't build the packet.");
    } finally {
      setBuilding(false);
      setProgress("");
    }
  }

  // AC2 wants "a PDF to read". There is no PDF generator in this bundle and
  // adding one to ship a table would be 300KB for a page the browser already
  // renders. The repo's existing answer is the same one -- cert-share-actions
  // prints the certificate -- so the packet opens its own readable page and
  // calls print, which every browser writes to PDF.
  async function printable() {
    if (!user) return;
    setBuilding(true);
    try {
      const input = await gather();
      const w = window.open("", "_blank", "width=900,height=1000");
      if (!w) {
        toast.error("Your browser blocked the window. Allow pop-ups and retry.");
        return;
      }
      w.document.write(buildPacketHtml(input));
      w.document.close();
      w.focus();
      // The stylesheet is inline, so there is nothing to wait on but layout.
      setTimeout(() => w.print(), 250);
    } catch (err) {
      toastError(err, "Couldn't build the packet.");
    } finally {
      setBuilding(false);
      setProgress("");
    }
  }

  const years = [1, 2, 3].map((n) => new Date().getFullYear() - n);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Your year-end packet</CardTitle>
        <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-muted-foreground">
          One download with everything an accountant asks for, plus the receipts
          themselves. Built from your books, with anything doubtful flagged on
          the front page.
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="tp-year" className="text-xs">
              Tax year
            </Label>
            <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
              <SelectTrigger id="tp-year" className="h-9 w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {years.map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button onClick={build} disabled={building}>
            <FileArchive className="mr-2 h-4 w-4" />
            {building ? progress || "Building" : `Build the ${label} packet`}
          </Button>
          <Button variant="outline" onClick={printable} disabled={building}>
            <Printer className="mr-2 h-4 w-4" />
            Print or save as PDF
          </Button>
        </div>

        <div className="rounded-md border p-3">
          <p className="text-sm font-medium">What is in it</p>
          <ul className="mt-1.5 space-y-0.5 text-[13px] leading-relaxed text-muted-foreground">
            <li>A Schedule C worksheet with the line numbers filled in</li>
            <li>Cost of goods sold, Part III</li>
            <li>Your 1099-K reconciliation for each platform</li>
            <li>The mileage log and the Part IV questions</li>
            <li>The home office computation</li>
            <li>What you were holding at the end of the year</li>
            <li>Every receipt you attached, as actual files</li>
          </ul>

          {/* AC4. Saying what is absent is worth more than another number: an
              accountant who assumes state tax is in here finds out late. */}
          <p className="mt-3 flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="h-4 w-4 text-amber-700 dark:text-amber-400" />
            What is not in it
          </p>
          <ul className="mt-1.5 space-y-0.5 text-[13px] leading-relaxed text-muted-foreground">
            {PACKET_EXCLUSIONS.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>

        <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
          GradeThread does the arithmetic on your own records. It does not give
          tax advice and does not file anything.
        </p>
      </CardContent>
    </Card>
  );
}

/** The readable half of the packet (AC2). */
function buildPacketHtml(input: PacketInput): string {
  const warnings = packetWarnings(input);
  const rows = scheduleCRows(input);
  const money = (c: number) => formatCents(c);

  const warnHtml = warnings.length
    ? `<h2>Read this first</h2><ul>${warnings
        .map(
          (w) =>
            `<li><strong>${escapeHtml(w.headline)}</strong><br>${escapeHtml(w.detail)}</li>`,
        )
        .join("")}</ul>`
    : `<p class="ok">Nothing was flagged in these books.</p>`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Tax packet ${escapeHtml(input.taxYear)}</title>
<style>
body{font-family:Arial,Helvetica,sans-serif;margin:40px;color:#1A1A2E;max-width:46em}
h1{color:#0F3460;margin:0 0 4px}h2{color:#0F3460;font-size:15px;margin-top:28px}
.sub{color:#666;margin-bottom:20px}
table{width:100%;border-collapse:collapse;margin-top:8px}
td,th{padding:6px 10px;border-bottom:1px solid #e5e5e5;font-size:13px;text-align:left}
.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.line{color:#777;width:4em}
ul{padding-left:18px}li{font-size:13px;margin-bottom:6px}
.ok{color:#2f6f4f;font-size:13px}
.footer{margin-top:32px;font-size:11px;color:#888;border-top:1px solid #ddd;padding-top:10px}
@media print{body{margin:16px}}
</style></head><body>
<h1>Tax packet ${escapeHtml(input.taxYear)}</h1>
<div class="sub">${escapeHtml(input.from)} to ${escapeHtml(input.to)} (end exclusive)
 &middot; ${escapeHtml(input.accountingMethod === "cash" ? "Cash basis" : "Accrual basis")}
 &middot; ${escapeHtml(input.entityType.replace(/_/g, " "))}
 &middot; filing ${escapeHtml(input.filingStatus.replace(/_/g, " "))}</div>
${warnHtml}
<h2>Schedule C worksheet</h2>
<table><tbody>
${rows
  .map(
    (r) =>
      `<tr><td class="line">${escapeHtml(r.line)}</td><td>${escapeHtml(r.label)}</td><td class="num">${escapeHtml(money(r.cents))}</td></tr>`,
  )
  .join("")}
</tbody></table>
<h2>What is not in this packet</h2>
<ul>${PACKET_EXCLUSIONS.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>
<div class="footer">
The spreadsheet beside this file carries the full detail: cost of goods sold, the
1099-K reconciliation, the mileage log, the home office computation and the
inventory count. The receipts folder holds the evidence as actual files.<br><br>
Generated by GradeThread on ${escapeHtml(new Date().toLocaleDateString())}.
GradeThread does the arithmetic on the seller's own records. It does not give tax
advice, does not file anything, and takes no position on any judgement call.
</div></body></html>`;
}
