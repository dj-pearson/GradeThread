import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Mailbox, RefreshCw, Search, Download, Loader2 } from "lucide-react";

// US-912: admin view + CSV export of the standalone newsletter subscriber list.
// Confirmed rows are the emailable list; pending/unsubscribed/bounced are shown
// for visibility. Read-only (no mutation) — inherits admin JWT + AAL2.

type SubscriberStatus = "pending" | "confirmed" | "unsubscribed" | "bounced" | "cleaned";

interface Subscriber {
  email: string;
  status: SubscriberStatus;
  source: string | null;
  user_id: string | null;
  confirmed_at: string | null;
  unsubscribed_at: string | null;
  created_at: string;
}

const STATUS_LABEL: Record<SubscriberStatus, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  unsubscribed: "Unsubscribed",
  bounced: "Bounced",
  cleaned: "Cleaned",
};

const STATUS_VARIANT: Record<SubscriberStatus, "default" | "secondary" | "outline" | "destructive"> = {
  pending: "secondary",
  confirmed: "default",
  unsubscribed: "outline",
  bounced: "destructive",
  cleaned: "outline",
};

const FILTERS: Array<{ value: "" | SubscriberStatus; label: string }> = [
  { value: "", label: "All" },
  { value: "confirmed", label: "Confirmed" },
  { value: "pending", label: "Pending" },
  { value: "unsubscribed", label: "Unsubscribed" },
  { value: "bounced", label: "Bounced" },
];

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

export function AdminNewsletterSubscribersPage() {
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | SubscriberStatus>("");
  const [exporting, setExporting] = useState(false);

  const subscribers = useQuery({
    queryKey: ["newsletter-subscribers", search, statusFilter],
    queryFn: async (): Promise<{ subscribers: Subscriber[]; counts: Record<string, number> }> => {
      const params = new URLSearchParams();
      if (search) params.set("q", search);
      if (statusFilter) params.set("status", statusFilter);
      const qs = params.toString();
      const res = await edgeFetch(`/api/admin/subscribers${qs ? `?${qs}` : ""}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load subscribers");
      return {
        subscribers: (json.subscribers ?? []) as Subscriber[],
        counts: (json.counts ?? {}) as Record<string, number>,
      };
    },
    staleTime: 15_000,
  });

  async function exportCsv() {
    setExporting(true);
    try {
      const qs = statusFilter ? `?status=${statusFilter}` : "";
      const res = await edgeFetch(`/api/admin/subscribers/export${qs}`);
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        toast.error((json as { error?: string }).error ?? "Export failed");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `subscribers${statusFilter ? `-${statusFilter}` : ""}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Export downloaded");
    } catch {
      toast.error("Export failed");
    } finally {
      setExporting(false);
    }
  }

  const rows = subscribers.data?.subscribers ?? [];
  const counts = subscribers.data?.counts ?? {};

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Mailbox className="h-6 w-6 text-brand-navy" />
            Newsletter Subscribers
          </h1>
          <p className="text-sm text-muted-foreground">
            Standalone leads who signed up for the newsletter (double opt-in). Only{" "}
            <strong>confirmed</strong> subscribers are emailable. Registered users are linked
            by email so they aren't emailed twice.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void subscribers.refetch()}
            disabled={subscribers.isFetching}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${subscribers.isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void exportCsv()} disabled={exporting}>
            {exporting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-2 h-4 w-4" />
            )}
            Export CSV
          </Button>
        </div>
      </div>

      {/* Per-status totals. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(["confirmed", "pending", "unsubscribed", "bounced"] as SubscriberStatus[]).map((s) => (
          <Card key={s}>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">{STATUS_LABEL[s]}</p>
              <p className="text-2xl font-bold">{counts[s] ?? 0}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Subscriber list</CardTitle>
          <CardDescription>Most recent first. Search by email substring.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setSearch(q.trim());
              }}
            >
              <Input
                aria-label="Search subscribers"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search email…"
                className="max-w-sm"
              />
              <Button type="submit" variant="secondary" size="sm">
                <Search className="mr-2 h-4 w-4" />
                Search
              </Button>
            </form>
            <div className="flex flex-wrap gap-1">
              {FILTERS.map((f) => (
                <Button
                  key={f.value || "all"}
                  variant={statusFilter === f.value ? "default" : "outline"}
                  size="sm"
                  onClick={() => setStatusFilter(f.value)}
                >
                  {f.label}
                </Button>
              ))}
            </div>
          </div>

          {subscribers.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : subscribers.isError ? (
            <p className="text-sm text-destructive">
              {(subscribers.error as Error)?.message ?? "Failed to load subscribers"}
            </p>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No subscribers{search || statusFilter ? " match that filter" : ""}.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Account</TableHead>
                  <TableHead>Confirmed</TableHead>
                  <TableHead>Joined</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((s) => (
                  <TableRow key={s.email}>
                    <TableCell className="font-medium">{s.email}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[s.status]}>{STATUS_LABEL[s.status]}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{s.source ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.user_id ? "Linked" : "Lead"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {fmtDate(s.confirmed_at)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {fmtDate(s.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
