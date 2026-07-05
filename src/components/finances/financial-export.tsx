import { useState } from "react";
import { csvBlob, downloadBlob } from "@/lib/download";
import { escapeCsvCell } from "@/lib/items-csv";
import { escapeHtml } from "@/lib/escape-html";
import { fetchFinancesExport, type FinExportTxn } from "@/lib/finances-dashboard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Download, FileText, FileSpreadsheet, ChevronDown } from "lucide-react";
import { toast } from "sonner";

// US-1636: CSV cells go through the shared escaper, which also neutralizes
// spreadsheet formula injection (=/+/-/@) from marketplace-sourced text.
const escapeCsvField = escapeCsvCell;

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(value);
}

interface SummaryTotals {
  grossRevenue: number;
  acquisitionExpenses: number;
  shippingExpenses: number;
  feeExpenses: number;
  gradingExpenses: number;
  totalExpenses: number;
  netProfit: number;
}

function computeSummary(transactions: FinExportTxn[]): SummaryTotals {
  let grossRevenue = 0;
  let acquisitionExpenses = 0;
  let shippingExpenses = 0;
  let feeExpenses = 0;
  let gradingExpenses = 0;

  for (const t of transactions) {
    if (t.type === "income") {
      grossRevenue += t.amount;
    } else {
      switch (t.category) {
        case "acquisition":
          acquisitionExpenses += t.amount;
          break;
        case "shipping":
          shippingExpenses += t.amount;
          break;
        case "fee":
          feeExpenses += t.amount;
          break;
        case "grading":
          gradingExpenses += t.amount;
          break;
      }
    }
  }

  const totalExpenses = acquisitionExpenses + shippingExpenses + feeExpenses + gradingExpenses;
  const netProfit = grossRevenue - totalExpenses;

  return {
    grossRevenue,
    acquisitionExpenses,
    shippingExpenses,
    feeExpenses,
    gradingExpenses,
    totalExpenses,
    netProfit,
  };
}

function generateCsv(transactions: FinExportTxn[], summary: SummaryTotals): string {
  const lines: string[] = [];

  // Summary section
  lines.push("FINANCIAL SUMMARY");
  lines.push(`Gross Revenue,${summary.grossRevenue.toFixed(2)}`);
  lines.push(`Acquisition Expenses,${summary.acquisitionExpenses.toFixed(2)}`);
  lines.push(`Shipping Expenses,${summary.shippingExpenses.toFixed(2)}`);
  lines.push(`Platform Fee Expenses,${summary.feeExpenses.toFixed(2)}`);
  lines.push(`Grading Expenses,${summary.gradingExpenses.toFixed(2)}`);
  lines.push(`Total Expenses,${summary.totalExpenses.toFixed(2)}`);
  lines.push(`Net Profit,${summary.netProfit.toFixed(2)}`);
  lines.push("");

  // Transaction headers
  lines.push("TRANSACTION DETAILS");
  lines.push("Date,Type,Category,Amount,Item Title,Platform");

  // Transaction rows
  for (const t of transactions) {
    lines.push(
      [
        escapeCsvField(t.date),
        escapeCsvField(t.type),
        escapeCsvField(t.category),
        t.amount.toFixed(2),
        escapeCsvField(t.itemTitle),
        escapeCsvField(t.platform),
      ].join(",")
    );
  }

  return lines.join("\n");
}

function generatePdfHtml(
  transactions: FinExportTxn[],
  summary: SummaryTotals,
  startDate: string,
  endDate: string,
): string {
  const summaryRows = [
    ["Gross Revenue", formatCurrency(summary.grossRevenue)],
    ["Acquisition Expenses", formatCurrency(summary.acquisitionExpenses)],
    ["Shipping Expenses", formatCurrency(summary.shippingExpenses)],
    ["Platform Fee Expenses", formatCurrency(summary.feeExpenses)],
    ["Grading Expenses", formatCurrency(summary.gradingExpenses)],
    ["Total Expenses", formatCurrency(summary.totalExpenses)],
    ["Net Profit", formatCurrency(summary.netProfit)],
  ];

  // US-1635: escape EVERY cell — previously only itemTitle was (partially)
  // escaped, so marketplace-sourced platform/category went in raw (self-XSS
  // when this HTML is document.write()'n into a same-origin window).
  const transactionRows = transactions.map(
    (t) => `<tr>
      <td>${escapeHtml(t.date)}</td>
      <td>${escapeHtml(t.type)}</td>
      <td>${escapeHtml(t.category)}</td>
      <td style="text-align:right">${escapeHtml(formatCurrency(t.amount))}</td>
      <td>${escapeHtml(t.itemTitle)}</td>
      <td>${escapeHtml(t.platform)}</td>
    </tr>`
  );

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>GradeThread Financial Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 40px; color: #1A1A2E; }
    h1 { color: #0F3460; margin-bottom: 4px; }
    h2 { color: #0F3460; margin-top: 32px; }
    .period { color: #666; margin-bottom: 24px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #ddd; font-size: 13px; }
    th { background: #0F3460; color: white; }
    .summary-table { max-width: 400px; }
    .summary-table td:last-child { text-align: right; font-weight: 500; }
    .summary-table tr:last-child { font-weight: bold; border-top: 2px solid #0F3460; }
    .footer { margin-top: 40px; font-size: 11px; color: #999; border-top: 1px solid #ddd; padding-top: 12px; }
    @media print { body { margin: 20px; } }
  </style>
</head>
<body>
  <h1>GradeThread Financial Report</h1>
  <div class="period">${escapeHtml(startDate)} to ${escapeHtml(endDate)}</div>

  <h2>Summary</h2>
  <table class="summary-table">
    <tbody>
      ${summaryRows.map(([label, val]) => `<tr><td>${label}</td><td>${val}</td></tr>`).join("\n")}
    </tbody>
  </table>

  <h2>Transaction Details</h2>
  <table>
    <thead>
      <tr>
        <th>Date</th>
        <th>Type</th>
        <th>Category</th>
        <th style="text-align:right">Amount</th>
        <th>Item Title</th>
        <th>Platform</th>
      </tr>
    </thead>
    <tbody>
      ${transactionRows.join("\n")}
    </tbody>
  </table>

  <div class="footer">
    Generated by GradeThread on ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
  </div>
</body>
</html>`;
}

function downloadPdf(htmlContent: string, filename: string) {
  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    toast.error("Please allow popups to download the PDF report.");
    return;
  }
  printWindow.document.write(htmlContent);
  printWindow.document.close();
  printWindow.document.title = filename.replace(".pdf", "");
  // Give the browser time to render before printing
  setTimeout(() => {
    printWindow.print();
  }, 500);
}

function getCurrentTaxYearDates(): { start: string; end: string } {
  const now = new Date();
  const year = now.getFullYear();
  return {
    start: `${year}-01-01`,
    end: `${year}-12-31`,
  };
}

export function FinancialExport() {
  const defaults = getCurrentTaxYearDates();
  const [startDate, setStartDate] = useState(defaults.start);
  const [endDate, setEndDate] = useState(defaults.end);
  const [exporting, setExporting] = useState(false);

  // Fetch the ledger only when the user actually exports — the date range is
  // pushed to the query, so we never download the whole account (US-403).
  async function loadTransactions(): Promise<FinExportTxn[]> {
    return fetchFinancesExport(startDate, endDate);
  }

  async function handleExportCsv() {
    setExporting(true);
    try {
      const transactions = await loadTransactions();
      if (transactions.length === 0) {
        toast.info("No transactions found for the selected date range.");
        return;
      }
      const summary = computeSummary(transactions);
      const csv = generateCsv(transactions, summary);
      const filename = `gradethread_financial_report_${startDate}_${endDate}.csv`;
      downloadBlob(csvBlob(csv), filename);
      toast.success("CSV report downloaded.");
    } catch {
      toast.error("Failed to generate CSV report.");
    } finally {
      setExporting(false);
    }
  }

  async function handleExportPdf() {
    setExporting(true);
    try {
      const transactions = await loadTransactions();
      if (transactions.length === 0) {
        toast.info("No transactions found for the selected date range.");
        return;
      }
      const summary = computeSummary(transactions);
      const html = generatePdfHtml(transactions, summary, startDate, endDate);
      const filename = `gradethread_financial_report_${startDate}_${endDate}.pdf`;
      downloadPdf(html, filename);
      toast.success("PDF report opened for printing.");
    } catch {
      toast.error("Failed to generate PDF report.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          <FileText className="mr-1.5 inline-block h-4 w-4" />
          Export Financial Report
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1">
            <Label htmlFor="export-start">Start Date</Label>
            <Input
              id="export-start"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-40"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="export-end">End Date</Label>
            <Input
              id="export-end"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-40"
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button disabled={exporting}>
                <Download className="mr-1.5 h-4 w-4" />
                {exporting ? "Exporting..." : "Export"}
                <ChevronDown className="ml-1.5 h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={handleExportCsv}>
                <FileSpreadsheet className="mr-2 h-4 w-4" />
                Export as CSV
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleExportPdf}>
                <FileText className="mr-2 h-4 w-4" />
                Export as PDF
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Export income and expenses for the selected date range as a CSV or
          printable PDF.
        </p>
      </CardContent>
    </Card>
  );
}
