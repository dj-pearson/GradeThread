// US-1579: MeasureCard fulfillment queue (super-admin). Lists mail requests
// by status, exports the vendor CSV, and bulk-marks exported → shipped.
// Fulfillment itself is manual/vendor-side — this page is the queue's UI.

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, Mail, PackageCheck, Truck } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { edgeFetch } from "@/lib/edge-fetch";

type QueueStatus = "requested" | "exported" | "shipped";

interface QueueRow {
  id: string;
  owner_user_id: string;
  status: QueueStatus;
  card_version: number;
  plan_key: string | null;
  ship_name: string;
  address_line1: string;
  address_line2: string | null;
  city: string;
  state: string;
  postal_code: string;
  country: string;
  requested_at: string;
}

export function AdminMeasureCardsPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<QueueStatus>("requested");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["admin_measure_cards", status],
    queryFn: async (): Promise<QueueRow[]> => {
      const res = await edgeFetch(
        `/api/admin/measure-cards/requests?status=${status}`,
      );
      if (!res.ok) throw new Error("Could not load the queue");
      const json = (await res.json()) as { requests: QueueRow[] };
      return json.requests;
    },
  });

  const allSelected = useMemo(
    () => rows.length > 0 && rows.every((r) => selected.has(r.id)),
    [rows, selected],
  );

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  }
  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function bulkMark(next: "exported" | "shipped") {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      const res = await edgeFetch("/api/admin/measure-cards/requests/bulk", {
        method: "POST",
        json: { ids: [...selected], status: next },
      });
      const json = (await res.json().catch(() => ({}))) as {
        updated?: number;
        error?: string;
      };
      if (!res.ok) {
        toast.error(json.error ?? "Bulk update failed.");
        return;
      }
      toast.success(`Marked ${json.updated ?? 0} request(s) ${next}.`);
      setSelected(new Set());
      await qc.invalidateQueries({ queryKey: ["admin_measure_cards"] });
    } finally {
      setBusy(false);
    }
  }

  async function downloadCsv() {
    const res = await edgeFetch(
      `/api/admin/measure-cards/requests.csv?status=${status}`,
    );
    if (!res.ok) {
      toast.error("CSV export failed.");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `measure-card-${status}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="h-4 w-4" />
            MeasureCard fulfillment queue
          </CardTitle>
          <CardDescription>
            Mailed-card requests. Export the CSV for the print/mail vendor,
            then bulk-mark exported → shipped (shipping stamps the seller's
            profile card version).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Tabs value={status} onValueChange={(v) => { setStatus(v as QueueStatus); setSelected(new Set()); }}>
              <TabsList>
                <TabsTrigger value="requested">Requested</TabsTrigger>
                <TabsTrigger value="exported">Exported</TabsTrigger>
                <TabsTrigger value="shipped">Shipped</TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="outline" onClick={() => void downloadCsv()}>
                <Download className="mr-1.5 h-3.5 w-3.5" />
                CSV
              </Button>
              {status === "requested" && (
                <Button
                  size="sm"
                  disabled={busy || selected.size === 0}
                  onClick={() => void bulkMark("exported")}
                >
                  {busy ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <PackageCheck className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Mark exported ({selected.size})
                </Button>
              )}
              {status === "exported" && (
                <Button
                  size="sm"
                  disabled={busy || selected.size === 0}
                  onClick={() => void bulkMark("shipped")}
                >
                  {busy ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Truck className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Mark shipped ({selected.size})
                </Button>
              )}
            </div>
          </div>

          {isLoading ? (
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No {status} requests.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleAll}
                        aria-label="Select all"
                      />
                    </TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Address</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Card</TableHead>
                    <TableHead>Requested</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        <input
                          type="checkbox"
                          checked={selected.has(r.id)}
                          onChange={() => toggle(r.id)}
                          aria-label={`Select ${r.ship_name}`}
                        />
                      </TableCell>
                      <TableCell className="font-medium">{r.ship_name}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.address_line1}
                        {r.address_line2 ? `, ${r.address_line2}` : ""}, {r.city},{" "}
                        {r.state} {r.postal_code} {r.country}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{r.plan_key ?? "?"}</Badge>
                      </TableCell>
                      <TableCell>v{r.card_version}</TableCell>
                      <TableCell className="text-xs">
                        {new Date(r.requested_at).toLocaleDateString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
