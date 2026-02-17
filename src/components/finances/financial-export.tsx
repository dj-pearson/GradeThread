import { useState, useMemo } from "react";
import type { InventoryItemRow, SaleRow, ShipmentRow, ListingRow } from "@/types/database";
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

interface FinancialExportProps {
  items: InventoryItemRow[];
  sales: SaleRow[];
  shipments: ShipmentRow[];
  listings: ListingRow[];
}

interface TransactionRecord {
  date: string;
  type: "income" | "expense";
  category: "sale" | "acquisition" | "shipping" | "fee" | "grading";
  amount: number;
  itemTitle: string;
  platform: string;
}

function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(value);
}

function buildTransactions(
  items: InventoryItemRow[],
  sales: SaleRow[],
  shipments: ShipmentRow[],
  listings: ListingRow[],
  startDate: string,
  endDate: string,
): TransactionRecord[] {
  const itemById = new Map<string, InventoryItemRow>();
  for (const item of items) {
    itemById.set(item.id, item);
  }

  const shipmentBySaleId = new Map<string, ShipmentRow>();
  for (const s of shipments) {
    shipmentBySaleId.set(s.sale_id, s);
  }

  const listingById = new Map<string, ListingRow>();
  for (const l of listings) {
    listingById.set(l.id, l);
  }

  const transactions: TransactionRecord[] = [];

  // Acquisition expenses (from inventory items with acquired_date)
  for (const item of items) {
    if (item.acquired_date && item.acquired_price && item.acquired_price > 0) {
      const date = item.acquired_date.slice(0, 10);
      if (date >= startDate && date <= endDate) {
        transactions.push({
          date,
          type: "expense",
          category: "acquisition",
          amount: item.acquired_price,
          itemTitle: item.title,
          platform: "",
        });
      }
    }
  }

  // Sale income + platform fee expenses
  for (const sale of sales) {
    const saleDate = sale.sale_date.slice(0, 10);
    if (saleDate < startDate || saleDate > endDate) continue;

    const item = itemById.get(sale.inventory_item_id);
    const listing = sale.listing_id ? listingById.get(sale.listing_id) : null;
    const platform = listing?.platform ?? "";
    const title = item?.title ?? "Unknown Item";

    // Sale income
    transactions.push({
      date: saleDate,
      type: "income",
      category: "sale",
      amount: sale.sale_price,
      itemTitle: title,
      platform,
    });

    // Platform fees
    if (sale.platform_fees > 0) {
      transactions.push({
        date: saleDate,
        type: "expense",
        category: "fee",
        amount: sale.platform_fees,
        itemTitle: title,
        platform,
      });
    }

    // Shipping costs
    const shipment = shipmentBySaleId.get(sale.id);
    if (shipment) {
      const shipDate = shipment.ship_date?.slice(0, 10) ?? saleDate;
      const totalShipping = shipment.shipping_cost + shipment.label_cost;
      if (totalShipping > 0 && shipDate >= startDate && shipDate <= endDate) {
        transactions.push({
          date: shipDate,
          type: "expense",
          category: "shipping",
          amount: totalShipping,
          itemTitle: title,
          platform,
        });
      }
    }
  }

  // Sort by date ascending
  transactions.sort((a, b) => a.date.localeCompare(b.date));

  return transactions;
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

function computeSummary(transactions: TransactionRecord[]): SummaryTotals {
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

function generateCsv(transactions: TransactionRecord[], summary: SummaryTotals): string {
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
  transactions: TransactionRecord[],
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

  const transactionRows = transactions.map(
    (t) => `<tr>
      <td>${t.date}</td>
      <td>${t.type}</td>
      <td>${t.category}</td>
      <td style="text-align:right">${formatCurrency(t.amount)}</td>
      <td>${t.itemTitle.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</td>
      <td>${t.platform}</td>
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
  <div class="period">${startDate} to ${endDate}</div>

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

function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
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

export function FinancialExport({ items, sales, shipments, listings }: FinancialExportProps) {
  const defaults = getCurrentTaxYearDates();
  const [startDate, setStartDate] = useState(defaults.start);
  const [endDate, setEndDate] = useState(defaults.end);
  const [exporting, setExporting] = useState(false);

  const transactions = useMemo(
    () => buildTransactions(items, sales, shipments, listings, startDate, endDate),
    [items, sales, shipments, listings, startDate, endDate]
  );

  const summary = useMemo(() => computeSummary(transactions), [transactions]);

  function handleExportCsv() {
    setExporting(true);
    try {
      if (transactions.length === 0) {
        toast.info("No transactions found for the selected date range.");
        return;
      }
      const csv = generateCsv(transactions, summary);
      const filename = `gradethread_financial_report_${startDate}_${endDate}.csv`;
      downloadFile(csv, filename, "text/csv;charset=utf-8;");
      toast.success("CSV report downloaded.");
    } catch {
      toast.error("Failed to generate CSV report.");
    } finally {
      setExporting(false);
    }
  }

  function handleExportPdf() {
    setExporting(true);
    try {
      if (transactions.length === 0) {
        toast.info("No transactions found for the selected date range.");
        return;
      }
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
          {transactions.length} transaction{transactions.length !== 1 ? "s" : ""} in selected period
          {" \u00B7 "}
          Net: {formatCurrency(summary.netProfit)}
        </p>
      </CardContent>
    </Card>
  );
}
