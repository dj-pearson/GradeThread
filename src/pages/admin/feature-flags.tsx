import { useEffect, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/ui/page-header";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
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
import { edgeFetch } from "@/lib/edge-fetch";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import { useAuth } from "@/hooks/use-auth";
import { AlertTriangle, Flag, Pencil, Users } from "lucide-react";

// US-886: feature flags v2 — gradual rollout + plan/user targeting + schedule.
// Reads/toggle are admin-level (fast kill-switch during an incident); the
// targeting rule editor is super_admin + a fresh MFA step-up server-side.

interface FlagRow {
  key: string;
  enabled: boolean;
  description: string | null;
  rollout_percentage: number;
  plan_targets: string[];
  user_allow: string[];
  user_deny: string[];
  starts_at: string | null;
  ends_at: string | null;
  updated_at: string;
  // US-2406: false when this flag has a platform-wide caller (a scheduled job
  // that runs it with no user), so no plan can be resolved for it. The server
  // refuses plan_targets on those; the editor greys the control out to match.
  // Optional so a cached response from before this field shipped still renders.
  plan_targetable?: boolean;
}

interface FlagsResponse {
  flags: FlagRow[];
  plans: string[];
}

interface PreviewResponse {
  total_users: number;
  enabled_count: number;
  sample_size: number;
  sampled: boolean;
}

// ── datetime-local <-> ISO helpers ──
function isoToLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // datetime-local wants local wall-clock "YYYY-MM-DDTHH:mm".
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function localToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function parseIds(text: string): string[] {
  return Array.from(
    new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)),
  );
}

function ruleSummary(f: FlagRow): string {
  if (!f.enabled) return "Killed";
  const parts: string[] = [];
  parts.push(f.rollout_percentage >= 100 ? "All users" : `${f.rollout_percentage}%`);
  if (f.plan_targets.length) parts.push(f.plan_targets.join(", "));
  if (f.user_allow.length) parts.push(`+${f.user_allow.length} allow`);
  if (f.user_deny.length) parts.push(`−${f.user_deny.length} deny`);
  if (f.starts_at || f.ends_at) parts.push("scheduled");
  return parts.join(" · ");
}

// ── Rule editor dialog ──
function RuleEditorDialog({
  flag,
  plans,
  onOpenChange,
  onSave,
  pending,
}: {
  flag: FlagRow | null;
  plans: string[];
  onOpenChange: (o: boolean) => void;
  onSave: (key: string, payload: Record<string, unknown>) => void;
  pending: boolean;
}) {
  const [seededFor, setSeededFor] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [pct, setPct] = useState(100);
  const [planTargets, setPlanTargets] = useState<string[]>([]);
  const [allowText, setAllowText] = useState("");
  const [denyText, setDenyText] = useState("");
  const [startsLocal, setStartsLocal] = useState("");
  const [endsLocal, setEndsLocal] = useState("");
  // US-2335: ids for the label/control pairs below. useId, not slugs — this
  // dialog is one component instance per edited flag, and a duplicate id
  // re-points a label at the wrong control while still reading as correct.
  const rolloutId = useId();
  const allowId = useId();
  const denyId = useId();
  const startsId = useId();
  const endsId = useId();

  // Seed local state once per opened flag.
  if (flag && seededFor !== flag.key) {
    setEnabled(flag.enabled);
    setPct(flag.rollout_percentage);
    setPlanTargets(flag.plan_targets);
    setAllowText(flag.user_allow.join("\n"));
    setDenyText(flag.user_deny.join("\n"));
    setStartsLocal(isoToLocal(flag.starts_at));
    setEndsLocal(isoToLocal(flag.ends_at));
    setSeededFor(flag.key);
  }

  const proposed: Record<string, unknown> = {
    key: flag?.key,
    enabled,
    rollout_percentage: pct,
    plan_targets: planTargets,
    user_allow: parseIds(allowText),
    user_deny: parseIds(denyText),
    starts_at: localToIso(startsLocal),
    ends_at: localToIso(endsLocal),
  };

  // ── Live "who this resolves to" preview (debounced) ──
  const [debounced, setDebounced] = useState("");
  const serialized = JSON.stringify(proposed);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(serialized), 400);
    return () => clearTimeout(t);
  }, [serialized]);

  const preview = useQuery({
    queryKey: ["admin-flag-preview", debounced],
    enabled: flag != null && debounced !== "",
    queryFn: async (): Promise<PreviewResponse> => {
      const res = await edgeFetch("/api/admin/feature-flags/preview", {
        method: "POST",
        json: JSON.parse(debounced),
        silentGate: true,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Preview failed");
      return json;
    },
    staleTime: 10_000,
  });

  const togglePlan = (p: string) =>
    setPlanTargets((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  const scheduleInvalid = Boolean(
    startsLocal && endsLocal && new Date(endsLocal) <= new Date(startsLocal),
  );
  // US-2406: default TRUE when the field is absent, so an older cached list
  // doesn't lock the control for a flag that can in fact be targeted — the
  // server still refuses the save either way.
  const planTargetable = flag?.plan_targetable !== false;

  return (
    <Dialog open={flag != null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Flag className="h-4 w-4" /> Targeting — {flag?.key}
          </DialogTitle>
          <DialogDescription>
            Gradual rollout + plan/user targeting + schedule. A global kill
            (Enabled off) always wins over every rule below. Requires a
            super-admin MFA step-up; changes apply across the fleet within ~30s.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Enabled / kill */}
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <div className="font-medium">Enabled</div>
              <p className="text-xs text-muted-foreground">
                Master switch. Off = killed for everyone, ignoring all targeting.
              </p>
            </div>
            <Button
              type="button"
              variant={enabled ? "default" : "destructive"}
              size="sm"
              onClick={() => setEnabled((v) => !v)}
            >
              {enabled ? "On" : "Off"}
            </Button>
          </div>

          {/* Rollout percentage */}
          <div className="space-y-2">
            <Label htmlFor={rolloutId}>Rollout: {pct}% of users</Label>
            <div className="flex items-center gap-3">
              <input
                id={rolloutId}
                type="range"
                min={0}
                max={100}
                value={pct}
                onChange={(e) => setPct(Number(e.target.value))}
                className="h-2 w-full cursor-pointer accent-primary"
                disabled={!enabled}
              />
              {/* The label above points at the SLIDER; this box is the same
                  value by another route, so it needs a name of its own. */}
              <Input
                aria-label="Rollout percentage"
                type="number"
                min={0}
                max={100}
                value={pct}
                onChange={(e) =>
                  setPct(Math.max(0, Math.min(100, Math.trunc(Number(e.target.value)))))
                }
                className="w-20"
                disabled={!enabled}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Deterministic per user (stable hash) — the same users stay in as you
              ramp up. Only applies to callers that pass a user id.
            </p>
          </div>

          {/* Plan targeting */}
          <div className="space-y-2">
            <Label>Plan targeting</Label>
            <div className="flex flex-wrap gap-2">
              {plans.map((p) => {
                const on = planTargets.includes(p);
                return (
                  <Badge
                    key={p}
                    variant={on ? "default" : "outline"}
                    className={planTargetable
                      ? "cursor-pointer capitalize"
                      : "cursor-not-allowed capitalize opacity-50"}
                    onClick={() => enabled && planTargetable && togglePlan(p)}
                  >
                    {p}
                  </Badge>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              {!planTargetable
                ? "This flag is checked by a scheduled job that runs for everyone at once, so there is no one plan to match. Use rollout percentage, the allow list, or the schedule instead."
                : planTargets.length === 0
                ? "No plans selected = all plans."
                : `Limited to: ${planTargets.join(", ")}. Matched against the plan the account is actually entitled to, so a lapsed subscription counts as Free.`}
            </p>
          </div>

          {/* User overrides */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={allowId}>Allow list (user ids)</Label>
              <Textarea
                id={allowId}
                value={allowText}
                onChange={(e) => setAllowText(e.target.value)}
                placeholder="one UUID per line"
                rows={3}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={denyId}>Deny list (user ids)</Label>
              <Textarea
                id={denyId}
                value={denyText}
                onChange={(e) => setDenyText(e.target.value)}
                placeholder="one UUID per line"
                rows={3}
                className="font-mono text-xs"
              />
            </div>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            Allow overrides plan + percentage. Deny overrides everything (but a
            global kill still wins).
          </p>

          {/* Schedule */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={startsId}>Starts at</Label>
              <Input
                id={startsId}
                type="datetime-local"
                value={startsLocal}
                onChange={(e) => setStartsLocal(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={endsId}>Ends at</Label>
              <Input
                id={endsId}
                type="datetime-local"
                value={endsLocal}
                onChange={(e) => setEndsLocal(e.target.value)}
              />
            </div>
          </div>
          {scheduleInvalid && (
            <p className="-mt-2 text-xs text-red-600 dark:text-red-400">
              Ends at must be after starts at.
            </p>
          )}

          <Separator />

          {/* Live preview */}
          <div className="flex items-center gap-2 rounded-md bg-muted/50 p-3 text-sm">
            <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
            {preview.isLoading ? (
              <span className="text-muted-foreground">Calculating reach…</span>
            ) : preview.error ? (
              <span className="text-muted-foreground">Preview unavailable</span>
            ) : preview.data ? (
              <span>
                Resolves to{" "}
                <strong>{preview.data.enabled_count.toLocaleString()}</strong> of{" "}
                {preview.data.total_users.toLocaleString()} users
                {preview.data.sampled && (
                  <span className="text-muted-foreground">
                    {" "}
                    (estimated from a {preview.data.sample_size.toLocaleString()}-user
                    sample)
                  </span>
                )}
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => flag && onSave(flag.key, proposed)}
            disabled={pending || scheduleInvalid}
          >
            {pending ? "Saving…" : "Save targeting"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AdminFeatureFlagsPage() {
  const qc = useQueryClient();
  const { profile } = useAuth();
  const isSuperAdmin = profile?.role === "super_admin";

  const [editFlag, setEditFlag] = useState<FlagRow | null>(null);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [retry, setRetry] = useState<null | (() => void)>(null);

  const flags = useQuery({
    queryKey: ["admin-feature-flags"],
    queryFn: async (): Promise<FlagsResponse> => {
      const res = await edgeFetch("/api/admin/feature-flags");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load feature flags.");
      return json;
    },
    staleTime: 30_000,
  });

  // Step-up-aware runner (mirrors AdminConfigPricingPage).
  async function run(doFetch: () => Promise<Response>, onOk: () => void) {
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
        toast.error((j as { error?: string }).error ?? "Save failed");
        return;
      }
      onOk();
    } finally {
      setWorking(false);
    }
  }

  // Fast kill-switch toggle (admin-level, no step-up).
  const toggleEnabled = (f: FlagRow) =>
    run(
      () =>
        edgeFetch("/api/admin/feature-flags", {
          method: "PUT",
          json: { key: f.key, enabled: !f.enabled },
          silentGate: true,
        }),
      () => {
        toast.success(`${f.key} ${f.enabled ? "disabled" : "enabled"}`);
        qc.invalidateQueries({ queryKey: ["admin-feature-flags"] });
      },
    );

  const saveRule = (key: string, payload: Record<string, unknown>) =>
    run(
      () =>
        edgeFetch(`/api/admin/feature-flags/${encodeURIComponent(key)}/rule`, {
          method: "PUT",
          json: payload,
          silentGate: true,
        }),
      () => {
        toast.success("Targeting updated");
        setEditFlag(null);
        qc.invalidateQueries({ queryKey: ["admin-feature-flags"] });
      },
    );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Feature Flags"
        subtitle={
          <>
            Runtime kill-switches with gradual rollout, plan/user targeting, and
            scheduling — no redeploy.
            {isSuperAdmin
              ? " Edits apply live within ~30s."
              : " Toggling is available to your role; the targeting editor needs super-admin."}
          </>
        }
      />

      <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          A flag flipped <strong>off</strong> kills the flow for everyone,
          overriding any targeting rule. Percentage + plan targeting only apply to
          callers that pass a user id/plan — established kill-switch callers behave
          exactly as before.
        </span>
      </div>

      {flags.error && (
        <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          <AlertTriangle className="h-4 w-4" />
          {(flags.error as Error).message}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Flag className="h-5 w-5" />
            Flags
          </CardTitle>
          <CardDescription>
            Each flow's runtime switch and its current targeting rule.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {flags.isLoading ? (
            <div className="p-6">
              <Skeleton className="h-40 w-full" />
            </div>
          ) : !flags.data || flags.data.flags.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No feature flags configured.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Flag</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Targeting</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {flags.data.flags.map((f) => (
                  <TableRow key={f.key}>
                    <TableCell>
                      <div className="font-mono text-sm font-medium">{f.key}</div>
                      {f.description && (
                        <div className="text-xs text-muted-foreground">{f.description}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={f.enabled ? "default" : "destructive"}>
                        {f.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {ruleSummary(f)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={working}
                          onClick={() => toggleEnabled(f)}
                        >
                          {f.enabled ? "Disable" : "Enable"}
                        </Button>
                        {isSuperAdmin && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={working}
                            onClick={() => setEditFlag(f)}
                            title="Edit targeting"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {isSuperAdmin && (
        <RuleEditorDialog
          flag={editFlag}
          // US-2398: the fallback list is the LIVE flipdesk_plan vocabulary. It
          // used to be the frozen users.plan enum, so on a failed flag load the
          // editor offered tiers the server would then reject.
          plans={flags.data?.plans ?? ["free", "starter", "pro", "business"]}
          onOpenChange={(o) => {
            if (!o) setEditFlag(null);
          }}
          onSave={saveRule}
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
