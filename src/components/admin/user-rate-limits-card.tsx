import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Gauge, Loader2, ShieldBan, Trash2 } from "lucide-react";
import { toast } from "sonner";

// US-890: per-user rate-limit administration — the "Limits" section on the admin
// user-detail page (also reused from the Trust & Safety rate-limits console).
// Shows the user's recent rate-limit counters, any active temporary override, and
// lets a super-admin set/lift an override (throttle/boost/block). Writes go
// through the audited, MFA-step-up-gated edge endpoints; on STEP_UP_REQUIRED the
// authenticator dialog opens and the action retries.

type OverrideMode = "multiplier" | "cap" | "block";

interface ActiveOverride {
  subjectUserId: string;
  mode: OverrideMode;
  multiplier: number | null;
  cap: number | null;
  reason: string;
  expiresAt: string;
  createdAt: string;
}

interface CounterRow {
  scope: string;
  count: number;
  windowStart: string;
}

interface RateLimitsResponse {
  userId: string;
  windowMinutes: number;
  counters: CounterRow[];
  override: ActiveOverride | null;
  bounds: {
    maxMultiplier: number;
    maxDurationMinutes: number;
    gradeDefaultPerMin: number;
  };
}

function formatExpiry(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function describeOverride(o: ActiveOverride): string {
  if (o.mode === "block") return "Hard block — all requests rejected";
  if (o.mode === "cap") return `Capped at ${o.cap} requests / window`;
  return `Limits ×${o.multiplier}`;
}

export function UserRateLimitsCard({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["admin-rate-limits", userId];

  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: async (): Promise<RateLimitsResponse> => {
      const res = await edgeFetch(`/api/admin/safety/rate-limits/${userId}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      return json as RateLimitsResponse;
    },
    staleTime: 15 * 1000,
  });

  const [mode, setMode] = useState<OverrideMode>("multiplier");
  const [value, setValue] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [reason, setReason] = useState("");
  // US-2335: this card is rendered per user, so useId rather than slugs.
  const modeId = useId();
  const valueId = useId();
  const minutesId = useId();
  const reasonId = useId();
  const [saving, setSaving] = useState(false);
  const [lifting, setLifting] = useState(false);
  const [setStepUpOpen, setSetStepUpOpen] = useState(false);
  const [liftStepUpOpen, setLiftStepUpOpen] = useState(false);

  const active = data?.override ?? null;
  const bounds = data?.bounds;

  function invalidate() {
    queryClient.invalidateQueries({ queryKey });
  }

  async function handleSetOverride() {
    if (!reason.trim()) {
      toast.error("A reason is required.");
      return;
    }
    const mins = Number(minutes);
    if (!Number.isFinite(mins) || mins <= 0) {
      toast.error("Duration must be a positive number of minutes.");
      return;
    }
    const body: Record<string, unknown> = {
      mode,
      reason: reason.trim(),
      expiresInMinutes: mins,
    };
    if (mode === "multiplier") body.multiplier = Number(value);
    if (mode === "cap") body.cap = Number(value);

    setSaving(true);
    try {
      const res = await edgeFetch(`/api/admin/safety/rate-limits/${userId}/override`, {
        method: "POST",
        json: body,
        silentGate: true,
      });
      if (res.status === 403) {
        const j = await res.json().catch(() => ({}));
        if (j?.code === "STEP_UP_REQUIRED") {
          setSetStepUpOpen(true); // dialog's onVerified retries
          return;
        }
        throw new Error(j?.error ?? "Forbidden");
      }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`);
      toast.success("Rate-limit override applied.");
      setValue("");
      setReason("");
      invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to set override");
    } finally {
      setSaving(false);
    }
  }

  async function handleLift() {
    setLifting(true);
    try {
      const res = await edgeFetch(`/api/admin/safety/rate-limits/${userId}/override`, {
        method: "DELETE",
        silentGate: true,
      });
      if (res.status === 403) {
        const j = await res.json().catch(() => ({}));
        if (j?.code === "STEP_UP_REQUIRED") {
          setLiftStepUpOpen(true);
          return;
        }
        throw new Error(j?.error ?? "Forbidden");
      }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`);
      toast.success("Override lifted.");
      invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to lift override");
    } finally {
      setLifting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Gauge className="h-4 w-4" />
          Rate Limits
        </CardTitle>
        <CardDescription>
          Recent request counters and temporary per-user overrides (throttle, boost,
          or block). Overrides auto-expire.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <Skeleton className="h-32" />
        ) : (
          <>
            {/* Current counters */}
            <div>
              <h4 className="mb-2 text-sm font-semibold">
                Counters · last {data?.windowMinutes ?? 5}m
              </h4>
              {data && data.counters.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {data.counters.map((ctr) => (
                    <Badge key={ctr.scope} variant="secondary" className="font-mono text-xs">
                      {ctr.scope}: {ctr.count}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No requests counted in the recent window.
                </p>
              )}
            </div>

            {/* Active override */}
            {active && (
              <div className="rounded-lg border border-brand-red/30 bg-brand-red/5 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <ShieldBan className="h-4 w-4 text-brand-red-text" />
                      <span className="text-sm font-semibold">{describeOverride(active)}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Expires {formatExpiry(active.expiresAt)} · {active.reason}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleLift}
                    disabled={lifting}
                  >
                    {lifting ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="mr-2 h-4 w-4" />
                    )}
                    Lift
                  </Button>
                </div>
              </div>
            )}

            {/* Set / replace override */}
            <div className="space-y-3 rounded-lg border p-4">
              <h4 className="text-sm font-semibold">
                {active ? "Replace override" : "Set a temporary override"}
              </h4>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs" htmlFor={modeId}>Mode</Label>
                  <Select value={mode} onValueChange={(v) => setMode(v as OverrideMode)}>
                    <SelectTrigger id={modeId}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="multiplier">Multiplier (×base)</SelectItem>
                      <SelectItem value="cap">Cap (absolute / window)</SelectItem>
                      <SelectItem value="block">Block (reject all)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {mode !== "block" && (
                  <div className="space-y-1">
                    <Label className="text-xs" htmlFor={valueId}>
                      {mode === "multiplier"
                        ? `Multiplier (max ${bounds?.maxMultiplier ?? 20})`
                        : "Cap (requests / window)"}
                    </Label>
                    <Input
                      id={valueId}
                      type="number"
                      min={0}
                      step={mode === "multiplier" ? "0.1" : "1"}
                      value={value}
                      placeholder={mode === "multiplier" ? "e.g. 0.25 or 5" : "e.g. 10"}
                      onChange={(e) => setValue(e.target.value)}
                    />
                  </div>
                )}
                <div className="space-y-1">
                  <Label className="text-xs" htmlFor={minutesId}>
                    Duration (minutes, max {bounds?.maxDurationMinutes ?? 10080})
                  </Label>
                  <Input
                    id={minutesId}
                    type="number"
                    min={1}
                    value={minutes}
                    onChange={(e) => setMinutes(e.target.value)}
                  />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label className="text-xs" htmlFor={reasonId}>Reason</Label>
                  <Input
                    id={reasonId}
                    value={reason}
                    maxLength={300}
                    placeholder="Why this override is being applied"
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <Button onClick={handleSetOverride} disabled={saving}>
                  {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Apply override
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                A throttle/boost/block applies across every rate-limited surface for
                this user and requires confirming your authenticator. It is logged.
              </p>
            </div>
          </>
        )}
      </CardContent>

      {/* Step-up re-auth, then retry the pending action. */}
      <MfaStepUpDialog
        open={setStepUpOpen}
        onOpenChange={setSetStepUpOpen}
        onVerified={() => {
          void handleSetOverride();
        }}
      />
      <MfaStepUpDialog
        open={liftStepUpOpen}
        onOpenChange={setLiftStepUpOpen}
        onVerified={() => {
          void handleLift();
        }}
      />
    </Card>
  );
}
