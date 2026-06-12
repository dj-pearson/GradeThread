import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { edgeFetch } from "@/lib/edge-fetch";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import { useAuth } from "@/hooks/use-auth";
import { AlertTriangle, Tag, Plus, Trash2 } from "lucide-react";

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

// US-630: in-app coupon creation. Submits to the parent's step-up-aware runner.
function CreateCouponDialog({
  open,
  onOpenChange,
  onSubmit,
  pending,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSubmit: (payload: Record<string, unknown>) => void;
  pending: boolean;
}) {
  const [discountType, setDiscountType] = useState<"percent" | "amount">("percent");
  const [percentOff, setPercentOff] = useState("10");
  const [amountOff, setAmountOff] = useState("5");
  const currency = "usd";
  const [duration, setDuration] = useState<"once" | "repeating" | "forever">("once");
  const [durationInMonths, setDurationInMonths] = useState("3");
  const [maxRedemptions, setMaxRedemptions] = useState("");
  const [redeemBy, setRedeemBy] = useState("");
  const [name, setName] = useState("");
  const [promoCode, setPromoCode] = useState("");

  const submit = () => {
    const payload: Record<string, unknown> = {
      name: name || undefined,
      duration,
      max_redemptions: maxRedemptions ? Number(maxRedemptions) : undefined,
      redeem_by: redeemBy ? Math.floor(new Date(redeemBy).getTime() / 1000) : undefined,
      promo_code: promoCode || undefined,
    };
    if (discountType === "percent") payload.percent_off = Number(percentOff);
    else {
      payload.amount_off = Math.round(Number(amountOff) * 100); // dollars → cents
      payload.currency = currency;
    }
    if (duration === "repeating") payload.duration_in_months = Number(durationInMonths);
    onSubmit(payload);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New coupon</DialogTitle>
          <DialogDescription>
            Creates a Stripe coupon (and optional promo code). Requires a super-admin
            MFA step-up.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Internal name (optional)</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Spring sale" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Discount type</Label>
              <Select value={discountType} onValueChange={(v) => setDiscountType(v as "percent" | "amount")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="percent">Percent off</SelectItem>
                  <SelectItem value="amount">Amount off</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {discountType === "percent" ? (
              <div className="space-y-2">
                <Label>Percent off</Label>
                <Input type="number" value={percentOff} onChange={(e) => setPercentOff(e.target.value)} />
              </div>
            ) : (
              <div className="space-y-2">
                <Label>Amount off ({currency.toUpperCase()})</Label>
                <Input type="number" value={amountOff} onChange={(e) => setAmountOff(e.target.value)} />
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Duration</Label>
              <Select value={duration} onValueChange={(v) => setDuration(v as "once" | "repeating" | "forever")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="once">Once</SelectItem>
                  <SelectItem value="repeating">Repeating</SelectItem>
                  <SelectItem value="forever">Forever</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {duration === "repeating" && (
              <div className="space-y-2">
                <Label>Months</Label>
                <Input type="number" value={durationInMonths} onChange={(e) => setDurationInMonths(e.target.value)} />
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Max redemptions (optional)</Label>
              <Input type="number" value={maxRedemptions} onChange={(e) => setMaxRedemptions(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Redeem by (optional)</Label>
              <Input type="date" value={redeemBy} onChange={(e) => setRedeemBy(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Promo code (optional)</Label>
            <Input
              value={promoCode}
              onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
              placeholder="SPRING25"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? "Creating…" : "Create coupon"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AdminCouponsPage() {
  const qc = useQueryClient();
  const { profile } = useAuth();
  const isSuperAdmin = profile?.role === "super_admin";
  const [createOpen, setCreateOpen] = useState(false);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [retry, setRetry] = useState<null | (() => void)>(null);

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

  // Step-up-aware fetch runner shared by create + archive. On STEP_UP_REQUIRED
  // it stashes the retry and opens the authenticator dialog.
  async function run(doFetch: () => Promise<Response>, onOk: (json: unknown) => void) {
    setWorking(true);
    try {
      const res = await doFetch();
      if (res.status === 403) {
        const j = await res.json().catch(() => ({}));
        if ((j as { code?: string })?.code === "STEP_UP_REQUIRED") {
          setRetry(() => () => run(doFetch, onOk));
          setStepUpOpen(true);
          return;
        }
        toast.error((j as { error?: string })?.error ?? "Forbidden");
        return;
      }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error((j as { error?: string }).error ?? "Action failed");
        return;
      }
      onOk(j);
    } finally {
      setWorking(false);
    }
  }

  const createCoupon = (payload: Record<string, unknown>) =>
    run(
      () => edgeFetch("/api/admin/coupons", { method: "POST", json: payload, silentGate: true }),
      () => {
        toast.success("Coupon created");
        setCreateOpen(false);
        qc.invalidateQueries({ queryKey: ["admin-coupons"] });
      },
    );

  const archiveCoupon = (id: string) =>
    run(
      () => edgeFetch(`/api/admin/coupons/${id}/archive`, { method: "POST", json: {}, silentGate: true }),
      () => {
        toast.success("Coupon archived");
        qc.invalidateQueries({ queryKey: ["admin-coupons"] });
      },
    );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">Coupons & Promo Codes</h1>
          <p className="text-muted-foreground">
            Stripe coupons + active promotion codes.
            {isSuperAdmin ? " Create and archive them right here." : " Read-only for your role."}
          </p>
        </div>
        {isSuperAdmin && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 h-4 w-4" /> New coupon
          </Button>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
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
                  {isSuperAdmin && <TableHead className="text-right">Actions</TableHead>}
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
                    {isSuperAdmin && (
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          disabled={working}
                          onClick={() => {
                            if (confirm(`Archive coupon ${c.id}? New redemptions will be blocked.`)) {
                              archiveCoupon(c.id);
                            }
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    )}
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

      {isSuperAdmin && (
        <CreateCouponDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onSubmit={createCoupon}
          pending={working}
        />
      )}
      <MfaStepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => retry?.()}
      />
    </div>
  );
}
