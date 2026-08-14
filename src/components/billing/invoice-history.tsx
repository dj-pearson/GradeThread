import { useQuery } from "@tanstack/react-query";
import { Download, ExternalLink, FileText } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/error-state";
import { edgeFetch } from "@/lib/edge-fetch";

// US-2524: receipts in the app. Every path to "what was I charged" used to be a
// link out to the Stripe portal, which means leaving, signing in again and
// coming back. The list lives here; the PDF and the hosted page stay Stripe's,
// because those are the documents of record.

interface InvoiceRow {
  id: string;
  number: string | null;
  created: string;
  status: string | null;
  amount_paid: number;
  amount_due: number;
  currency: string;
  description: string | null;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
}

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  }).format(cents / 100);
}

function statusLabel(status: string | null): string {
  switch (status) {
    case "paid":
      return "Paid";
    case "open":
      return "Due";
    case "void":
      return "Voided";
    case "uncollectible":
      return "Unpaid";
    case "draft":
      return "Draft";
    default:
      return status ?? "—";
  }
}

function useInvoices() {
  return useQuery({
    queryKey: ["billing_invoices"],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<InvoiceRow[]> => {
      const res = await edgeFetch("/api/payments/invoices");
      const json = (await res.json().catch(() => ({}))) as {
        invoices?: InvoiceRow[];
        error?: string;
      };
      if (!res.ok) throw new Error(json.error || "Couldn't load your invoices.");
      return json.invoices ?? [];
    },
  });
}

export function InvoiceHistory() {
  const { data: invoices = [], isLoading, isError, refetch, isFetching } =
    useInvoices();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileText className="h-5 w-5" />
          Invoices &amp; receipts
        </CardTitle>
        <CardDescription>
          Every charge on this account. Open one for the itemized invoice with
          its tax breakdown, or download the PDF.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError ? (
          <ErrorState
            title="Couldn't load your invoices"
            description="Your charges are safe — this is the billing service."
            onRetry={() => refetch()}
            retrying={isFetching}
            hideSupport
          />
        ) : isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No invoices yet. Subscriptions and credit packs both appear here.
          </p>
        ) : (
          <ul className="divide-y">
            {invoices.map((inv) => (
              <li
                key={inv.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"
              >
                <span className="min-w-0">
                  <span className="block font-medium">
                    {new Date(inv.created).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                    {inv.number ? ` · ${inv.number}` : ""}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {inv.description ?? "Subscription"} · {statusLabel(inv.status)}
                  </span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="tabular-nums font-medium">
                    {money(
                      inv.status === "paid" ? inv.amount_paid : inv.amount_due,
                      inv.currency,
                    )}
                  </span>
                  {inv.hosted_invoice_url && (
                    <a
                      href={inv.hosted_invoice_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
                    >
                      View
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  {inv.invoice_pdf && (
                    <a
                      href={inv.invoice_pdf}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
                    >
                      PDF
                      <Download className="h-3 w-3" />
                    </a>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
