import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { edgeFetch } from "@/lib/edge-fetch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import { PageHeader } from "@/components/ui/page-header";
import { Layers, Loader2, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";

// US-1562: bulk admin operations over the US-589 endpoints
// (/api/admin/bulk/{credits,suspend,regrade}). The flow is deliberately
// three-step so an operator can't fat-finger 200 accounts:
//   1. paste targets → RESOLVE (server validates; unknowns surfaced, blocked)
//   2. review the resolved set + parameters
//   3. two-step CONFIRM dialog (shows the affected count) → fire with a
//      client-minted idempotency key; per-target results render after.
// Credits + suspend require a fresh MFA step-up (same gate as the single-user
// endpoints) — the STEP_UP_REQUIRED response opens the shared dialog and
// retries on verify. Re-firing after a partial failure is SAFE with the SAME
// key only if the server replays; for per-target retries mint a new key with
// only the failed targets (the UI offers exactly that).

type BulkOp = "credits" | "suspend" | "unsuspend" | "regrade";

const OP_META: Record<BulkOp, { label: string; target: "users" | "submissions"; blurb: string }> = {
  credits: {
    label: "Grant credits",
    target: "users",
    blurb: "Adds grade credits to each user (additive — protected by the idempotency key).",
  },
  suspend: {
    label: "Suspend accounts",
    target: "users",
    blurb: "Sets suspended=true on each user. Reversible via Unsuspend.",
  },
  unsuspend: {
    label: "Unsuspend accounts",
    target: "users",
    blurb: "Clears the suspended flag on each user.",
  },
  regrade: {
    label: "Re-run grading",
    target: "submissions",
    blurb: "Supersedes each submission's report and re-runs the grading pipeline (paste submission IDs).",
  },
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ResolvedUser {
  input: string;
  user_id: string;
  email: string;
  full_name: string | null;
  suspended: boolean;
}

interface PerTargetResult {
  id: string;
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

interface RunSummary {
  succeeded: number;
  skipped: number;
  failed: number;
  results: PerTargetResult[];
  replayed?: boolean;
}

export function AdminBulkPage() {
  const [searchParams] = useSearchParams();
  const [op, setOp] = useState<BulkOp>(() => {
    const q = searchParams.get("op");
    return q && q in OP_META ? (q as BulkOp) : "credits";
  });
  // Prefill from /admin/users multi-select handoff (?ids=a,b,c).
  const [rawTargets, setRawTargets] = useState(
    () => (searchParams.get("ids") ?? "").split(",").filter(Boolean).join("\n"),
  );
  const [credits, setCredits] = useState("5");
  const [reason, setReason] = useState("");

  const [resolving, setResolving] = useState(false);
  const [resolved, setResolved] = useState<ResolvedUser[] | null>(null);
  const [unknown, setUnknown] = useState<string[]>([]);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<RunSummary | null>(null);

  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [retryFn, setRetryFn] = useState<(() => void) | null>(null);

  const meta = OP_META[op];

  const entries = useMemo(
    () =>
      [...new Set(
        rawTargets.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean),
      )],
    [rawTargets],
  );

  // Regrade targets are raw submission UUIDs — validated client-side (no user
  // resolution applies).
  const submissionIds = useMemo(
    () => (meta.target === "submissions" ? entries.filter((e) => UUID_RE.test(e)) : []),
    [entries, meta.target],
  );
  const badSubmissionEntries = useMemo(
    () => (meta.target === "submissions" ? entries.filter((e) => !UUID_RE.test(e)) : []),
    [entries, meta.target],
  );

  function resetResolution() {
    setResolved(null);
    setUnknown([]);
    setSummary(null);
  }

  async function resolveTargets() {
    setResolving(true);
    setSummary(null);
    try {
      const res = await edgeFetch("/api/admin/bulk/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to resolve targets.");
      setResolved(json.resolved ?? []);
      setUnknown(json.unknown ?? []);
      if ((json.unknown ?? []).length > 0) {
        toast.warning(`${json.unknown.length} entr${json.unknown.length === 1 ? "y" : "ies"} didn't match any account.`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to resolve targets.");
    } finally {
      setResolving(false);
    }
  }

  const targetIds = meta.target === "users"
    ? (resolved ?? []).map((r) => r.user_id)
    : submissionIds;

  const paramsValid = op !== "credits" ||
    (Number.isInteger(Number(credits)) && Number(credits) > 0 && Number(credits) <= 1000 &&
      reason.trim().length > 0);

  const readyToConfirm = targetIds.length > 0 && paramsValid &&
    (meta.target === "submissions" ? badSubmissionEntries.length === 0 : unknown.length === 0);

  async function fire(ids: string[]) {
    const idempotencyKey = crypto.randomUUID();
    setRunning(true);
    try {
      const path = op === "regrade"
        ? "/api/admin/bulk/regrade"
        : op === "credits"
        ? "/api/admin/bulk/credits"
        : "/api/admin/bulk/suspend";
      const body: Record<string, unknown> = { idempotency_key: idempotencyKey };
      if (op === "regrade") body.submission_ids = ids;
      else body.user_ids = ids;
      if (op === "credits") {
        body.credits = Number(credits);
        body.reason = reason.trim();
      }
      if (op === "suspend" || op === "unsuspend") body.suspended = op === "suspend";

      const res = await edgeFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 403 && json.code === "STEP_UP_REQUIRED") {
        setRetryFn(() => () => void fire(ids));
        setStepUpOpen(true);
        return;
      }
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setSummary(json as RunSummary);
      setConfirmOpen(false);
      if ((json as RunSummary).failed > 0) {
        toast.warning(`${(json as RunSummary).failed} target(s) failed — see results below.`);
      } else {
        toast.success(`${meta.label}: ${(json as RunSummary).succeeded} succeeded.`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Operation failed.");
    } finally {
      setRunning(false);
    }
  }

  const failedIds = (summary?.results ?? []).filter((r) => !r.ok && !r.skipped).map((r) => r.id);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bulk operations"
        subtitle="Batch credits, suspensions, and regrades — validated, idempotent, audited (max 200 targets per run)."
        icon={Layers}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">1 · Operation & targets</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="bulk-operation">Operation</Label>
              <Select
                value={op}
                onValueChange={(v) => {
                  setOp(v as BulkOp);
                  resetResolution();
                }}
              >
                <SelectTrigger id="bulk-operation">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(OP_META) as BulkOp[]).map((k) => (
                    <SelectItem key={k} value={k}>{OP_META[k].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{meta.blurb}</p>
            </div>
            {op === "credits" && (
              <div className="space-y-2">
                <Label htmlFor="bulk-credits">Credits per user (1–1000)</Label>
                <Input
                  id="bulk-credits"
                  type="number"
                  min={1}
                  max={1000}
                  value={credits}
                  onChange={(e) => setCredits(e.target.value)}
                />
                <Label htmlFor="bulk-reason">Reason (audited)</Label>
                <Input
                  id="bulk-reason"
                  placeholder="e.g. June outage apology comp"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={500}
                />
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="bulk-targets">
              {meta.target === "users"
                ? "Target users — paste user IDs and/or emails (newline, comma, or space separated)"
                : "Target submissions — paste submission UUIDs"}
            </Label>
            <Textarea
              id="bulk-targets"
              rows={5}
              className="font-mono text-xs"
              placeholder={meta.target === "users"
                ? "a1b2c3d4-…\nseller@example.com"
                : "0f1e2d3c-…"}
              value={rawTargets}
              onChange={(e) => {
                setRawTargets(e.target.value);
                resetResolution();
              }}
            />
            <div className="flex items-center gap-3">
              {meta.target === "users"
                ? (
                  <Button size="sm" onClick={() => void resolveTargets()} disabled={entries.length === 0 || resolving}>
                    {resolving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Resolve {entries.length > 0 ? `${entries.length} entr${entries.length === 1 ? "y" : "ies"}` : "targets"}
                  </Button>
                )
                : (
                  <p className="text-sm text-muted-foreground">
                    {submissionIds.length} valid UUID{submissionIds.length === 1 ? "" : "s"}
                    {badSubmissionEntries.length > 0 && (
                      <span className="text-destructive"> · {badSubmissionEntries.length} invalid entr{badSubmissionEntries.length === 1 ? "y" : "ies"} (fix before running)</span>
                    )}
                  </p>
                )}
              <p className="text-xs text-muted-foreground">
                Tip: select rows on the Users page and choose “Bulk actions” to prefill this list.
              </p>
            </div>
          </div>

          {unknown.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/30">
              <p className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-300">
                <AlertTriangle className="h-4 w-4" />
                {unknown.length} entr{unknown.length === 1 ? "y" : "ies"} didn't resolve — remove or fix before running:
              </p>
              <p className="mt-1 font-mono text-xs break-all">{unknown.join(", ")}</p>
            </div>
          )}

          {resolved && resolved.length > 0 && (
            <div className="rounded-lg border">
              <div className="border-b px-3 py-2 text-sm font-medium">
                {resolved.length} account{resolved.length === 1 ? "" : "s"} resolved
              </div>
              <div className="max-h-56 overflow-y-auto">
                <Table>
                  <TableBody>
                    {resolved.map((r) => (
                      <TableRow key={r.user_id}>
                        <TableCell className="py-1.5 text-sm">{r.full_name ?? "—"}</TableCell>
                        <TableCell className="py-1.5 text-sm text-muted-foreground">{r.email}</TableCell>
                        <TableCell className="py-1.5">
                          {r.suspended && <Badge variant="destructive" className="text-xs">suspended</Badge>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}

          <Button
            onClick={() => setConfirmOpen(true)}
            disabled={!readyToConfirm || running}
            className="bg-brand-red hover:bg-brand-red/90"
          >
            Review & run {meta.label.toLowerCase()}…
          </Button>
        </CardContent>
      </Card>

      {summary && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              Results
              {summary.replayed && (
                <Badge variant="outline" className="text-xs">replayed (idempotent)</Badge>
              )}
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              {summary.succeeded} succeeded · {summary.skipped} skipped · {summary.failed} failed
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="max-h-72 overflow-y-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Target</TableHead>
                    <TableHead>Outcome</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summary.results.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="py-1.5 font-mono text-xs">{r.id}</TableCell>
                      <TableCell className="py-1.5 text-sm">
                        {r.ok && !r.skipped && (
                          <span className="flex items-center gap-1 text-green-700 dark:text-green-400">
                            <CheckCircle2 className="h-4 w-4" /> ok
                          </span>
                        )}
                        {r.skipped && <span className="text-muted-foreground">skipped</span>}
                        {!r.ok && !r.skipped && (
                          <span className="flex items-center gap-1 text-destructive">
                            <XCircle className="h-4 w-4" /> {r.error ?? "failed"}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {failedIds.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  // Retry ONLY the failed targets under a fresh idempotency key.
                  setRawTargets(failedIds.join("\n"));
                  resetResolution();
                  toast.info("Failed targets loaded — re-resolve and run again (new idempotency key).");
                }}
              >
                Load {failedIds.length} failed target{failedIds.length === 1 ? "" : "s"} for retry
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm: {meta.label}</DialogTitle>
            <DialogDescription>
              This fires one audited, idempotent batch. Review the numbers — there is no undo for credits.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p>
              <span className="font-semibold">{targetIds.length}</span>{" "}
              {meta.target === "users" ? "account(s)" : "submission(s)"} will be affected.
            </p>
            {op === "credits" && (
              <p>
                Each receives <span className="font-semibold">{credits} credit(s)</span> — reason: “{reason.trim()}”.
              </p>
            )}
            {op === "suspend" && <p className="text-destructive">All listed accounts will be suspended.</p>}
            {op === "unsuspend" && <p>All listed accounts will be reinstated.</p>}
            {op === "regrade" && <p>Each submission's current report is superseded and grading re-runs.</p>}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={running}>
              Cancel
            </Button>
            <Button
              onClick={() => void fire(targetIds)}
              disabled={running}
              className="bg-brand-red hover:bg-brand-red/90"
            >
              {running && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Run on {targetIds.length} target{targetIds.length === 1 ? "" : "s"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <MfaStepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => {
          setStepUpOpen(false);
          retryFn?.();
        }}
      />
    </div>
  );
}
