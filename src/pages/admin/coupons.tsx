import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { edgeFetch } from "@/lib/edge-fetch";
import { AlertTriangle, Tag } from "lucide-react";

interface AdminCoupon {
  id: string;
  name: string | null;
  percent_off: number | null;
  amount_off: number | null;
  currency: string | null;
  duration: "forever" | "once" | "repeating";
  duration_in_months: number | null;
  max_redemptions: number | null;
  times_redeemed: number;
  redeem_by: number | null;
  valid: boolean;
  created: number;
}

interface AdminPromoCode {
  id: string;
  code: string;
  coupon_id: string;
  max_redemptions: number | null;
  times_redeemed: number;
  expires_at: number | null;
  active: boolean;
  created: number;
}

interface AdminCouponsResponse {
  coupons: AdminCoupon[];
  promotion_codes: AdminPromoCode[];
}

function couponValue(c: AdminCoupon): string {
  if (c.percent_off != null) return `${c.percent_off}% off`;
  if (c.amount_off != null && c.currency) {
    return `${(c.amount_off / 100).toFixed(2)} ${c.currency.toUpperCase()} off`;
  }
  return "—";
}

function couponDuration(c: AdminCoupon): string {
  if (c.duration === "forever") return "Forever";
  if (c.duration === "once") return "One-time";
  if (c.duration === "repeating" && c.duration_in_months) {
    return `${c.duration_in_months} months`;
  }
  return c.duration;
}

function unixToDate(unix: number | null): string {
  if (!unix) return "—";
  return new Date(unix * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function AdminCouponsPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-coupons"],
    queryFn: async (): Promise<AdminCouponsResponse> => {
      const res = await edgeFetch("/api/admin/coupons");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load coupons.");
      return json;
    },
    staleTime: 60_000,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Coupons & Promo Codes</h1>
        <p className="text-muted-foreground">
          Read-only view of Stripe coupons + active promotion codes. Create
          new ones in the Stripe dashboard for now.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4" />
          {(error as Error).message}
        </div>
      )}

      {/* Coupons */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Tag className="h-5 w-5" />
            Coupons
          </CardTitle>
          <CardDescription>
            Stripe-side discount definitions. Promotion codes (below) reference
            these.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6">
              <Skeleton className="h-32 w-full" />
            </div>
          ) : !data || data.coupons.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No coupons configured. Create one in the Stripe dashboard.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID / Name</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Redemptions</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.coupons.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <div className="font-mono text-xs">{c.id}</div>
                      {c.name && <div className="text-xs text-muted-foreground">{c.name}</div>}
                    </TableCell>
                    <TableCell className="font-medium">{couponValue(c)}</TableCell>
                    <TableCell className="text-sm">{couponDuration(c)}</TableCell>
                    <TableCell className="tabular-nums">
                      {c.times_redeemed}
                      {c.max_redemptions != null ? ` / ${c.max_redemptions}` : ""}
                    </TableCell>
                    <TableCell className="text-sm">{unixToDate(c.redeem_by)}</TableCell>
                    <TableCell>
                      <Badge variant={c.valid ? "default" : "secondary"}>
                        {c.valid ? "Valid" : "Expired"}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Promotion codes */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Tag className="h-5 w-5" />
            Active promotion codes
          </CardTitle>
          <CardDescription>
            User-facing codes that map to a coupon. These are what customers
            enter at checkout.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6">
              <Skeleton className="h-32 w-full" />
            </div>
          ) : !data || data.promotion_codes.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No active promotion codes.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Coupon</TableHead>
                  <TableHead>Redemptions</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.promotion_codes.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-mono">{p.code}</TableCell>
                    <TableCell className="font-mono text-xs">{p.coupon_id}</TableCell>
                    <TableCell className="tabular-nums">
                      {p.times_redeemed}
                      {p.max_redemptions != null ? ` / ${p.max_redemptions}` : ""}
                    </TableCell>
                    <TableCell className="text-sm">{unixToDate(p.expires_at)}</TableCell>
                    <TableCell>
                      <Badge variant={p.active ? "default" : "secondary"}>
                        {p.active ? "Active" : "Inactive"}
                      </Badge>
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
