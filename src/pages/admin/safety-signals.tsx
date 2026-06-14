import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Link } from "react-router-dom";
import { edgeFetch } from "@/lib/edge-fetch";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  ShieldX,
  RefreshCw,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Ban,
  XCircle,
  Eye,
  ExternalLink,
} from "lucide-react";

// US-888 — Trust & Safety: fraud/abuse signals console.
//
// Lists the durable signals the abuse-scan cron persists (cross-account photo
// reuse + submission velocity), with a detail drawer. Triage moves a signal
// open -> reviewing -> actioned/dismissed (PATCH /api/admin/safety/signals/:id;
// resolving requires a fresh MFA step-up). Heavy actions REUSE the existing
// audited endpoints: suspend = POST /api/admin/users/:id/suspend, void grade =
// POST /api/admin/moderation/:submissionId/reject.

type SignalType = "phash_collision" | "submission_velocity" | "shared_payment" | "disposable_email";
type Severity = "low" | "medium" | "high" | "critical";
type Status = "open" | "reviewing" | "actioned" | "dismissed";

interface UserLite {
  userId: string;
  email: string | null;
  fullName: string | null;
  plan: string | null;
  suspended: boolean;
}

interface PhashMatch {
  subject_submission_id?: string;
  subject_image_id?: string;
  counterpart_submission_id?: string;
  counterpart_image_id?: string;
  image_type?: string | null;
  phash?: string;
  distance?: number;
}

interface Signal {
  id: string;
  signalType: SignalType;
  severity: Severity;
  status: Status;
  subjectUserId: string;
  subject: UserLite | null;
  counterpart: UserLite | null;
  evidence: Record<string, unknown>;
  resolutionReason: string | null;
  resolvedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  createdAt: string;
}

interface SignalsResponse {
  signals: Signal[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

const TYPE_LABEL: Record<SignalType, string> = {
  phash_collision: "Photo reuse",
  submission_velocity: "Velocity",
  shared_payment: "Shared payment",
  disposable_email: "Disposable email",
};

const SEVERITY_BADGE: Record<Severity, string> = {
  low: "bg-muted text-muted-foreground",
  medium: "bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-200",
  high: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
  critical: "bg-brand-red/15 text-brand-red-text",
};

const STATUS_BADGE: Record<Status, string> = {
  open: "bg-brand-red/15 text-brand-red-text",
  reviewing: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
  actioned: "bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-200",
  dismissed: "bg-muted text-muted-foreground",
};

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: "open", label: "Open" },
  { value: "reviewing", label: "Reviewing" },
  { value: "actioned", label: "Actioned" },
  { value: "dismissed", label: "Dismissed" },
  { value: "all", label: "All" },
];

async function getJson<T>(path: string): Promise<T> {
  const res = await edgeFetch(path, { silentGate: true });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

function userLabel(u: UserLite | null, fallbackId: string): string {
  if (!u) return `${fallbackId.slice(0, 8)}…`;
  return u.email ?? u.fullName ?? `${u.userId.slice(0, 8)}…`;
}

export function AdminSafetySignalsPage() {
  const [type, setType] = useState<string>("all");
  const [severity, setSeverity] = useState<string>("all");
  const [status, setStatus] = useState<string>("open");
  const [page, setPage] = useState(1);

  const [selected, setSelected] = useState<Signal | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [retry, setRetry] = useState<null | (() => void)>(null);

  const qs = new URLSearchParams({ status, page: String(page), page_size: "25" });
  if (type !== "all") qs.set("type", type);
  if (severity !== "all") qs.set("severity", severity);

  const query = useQuery({
    queryKey: ["admin-abuse-signals", status, type, severity, page],
    queryFn: () => getJson<SignalsResponse>(`/api/admin/safety/signals?${qs.toString()}`),
  });

  function handleStepUp(retryFn: () => void) {
    setRetry(() => retryFn);
    setStepUpOpen(true);
  }

  async function call(
    path: string,
    method: "POST" | "PATCH",
    json: unknown,
    okMsg: string,
    onDone?: () => void,
  ) {
    setBusy(true);
    try {
      const res = await edgeFetch(path, { method, json, silentGate: true });
      const j = await res.json().catch(() => ({}));
      if (res.status === 403 && (j as { code?: string })?.code === "STEP_UP_REQUIRED") {
        handleStepUp(() => void call(path, method, json, okMsg, onDone));
        return;
      }
      if (!res.ok) {
        toast.error((j as { error?: string })?.error ?? "Request failed");
        return;
      }
      toast.success(okMsg);
      onDone?.();
      void query.refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  function setSignalStatus(sig: Signal, next: Status) {
    if ((next === "actioned" || next === "dismissed") && !reason.trim()) {
      toast.error("Add a resolution reason first.");
      return;
    }
    void call(
      `/api/admin/safety/signals/${sig.id}`,
      "PATCH",
      { status: next, reason: reason.trim() || undefined },
      next === "reviewing" ? "Marked reviewing" : `Signal ${next}`,
      () => {
        setReason("");
        setSelected(null);
      },
    );
  }

  function suspendSubject(sig: Signal) {
    void call(
      `/api/admin/users/${sig.subjectUserId}/suspend`,
      "POST",
      { suspended: true },
      "User suspended",
    );
  }

  // Void/refund a graded submission referenced by a phash signal (reuses the
  // moderation reject endpoint, which refunds the grade credit).
  function voidGrade(submissionId: string) {
    void call(
      `/api/admin/moderation/${submissionId}/reject`,
      "POST",
      {},
      "Grade voided + credit refunded",
    );
  }

  const data = query.data;
  const signals = data?.signals ?? [];

  function changeFilter(setter: (v: string) => void, v: string) {
    setter(v);
    setPage(1);
  }

  const subjectSubmissionId = (() => {
    if (!selected) return null;
    const matches = selected.evidence.matches as PhashMatch[] | undefined;
    return matches?.[0]?.subject_submission_id ?? null;
  })();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ShieldX className="h-6 w-6 text-brand-red-text" />
          <div>
            <h1 className="text-2xl font-bold">Abuse Signals</h1>
            <p className="text-sm text-muted-foreground">
              Cross-account photo reuse, submission velocity and other fraud signals to investigate
              before chargebacks or grade-laundering. Resolving a signal requires a fresh second factor.
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>
          {query.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Refresh
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Status</Label>
          <Select value={status} onValueChange={(v) => changeFilter(setStatus, v)}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Type</Label>
          <Select value={type} onValueChange={(v) => changeFilter(setType, v)}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {(Object.keys(TYPE_LABEL) as SignalType[]).map((t) => (
                <SelectItem key={t} value={t}>{TYPE_LABEL[t]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Severity</Label>
          <Select value={severity} onValueChange={(v) => changeFilter(setSeverity, v)}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {(["critical", "high", "medium", "low"] as Severity[]).map((s) => (
                <SelectItem key={s} value={s}>{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* List */}
      {query.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20" />)}
        </div>
      ) : query.isError ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-destructive">
            {(query.error as Error)?.message ?? "Failed to load signals."}
          </CardContent>
        </Card>
      ) : signals.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            No signals match these filters. The abuse-scan job runs every 6 hours.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {signals.map((sig) => (
            <Card key={sig.id} className="cursor-pointer transition-colors hover:border-brand-red/40" onClick={() => { setSelected(sig); setReason(""); }}>
              <CardContent className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{TYPE_LABEL[sig.signalType]}</Badge>
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${SEVERITY_BADGE[sig.severity]}`}>{sig.severity}</span>
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[sig.status]}`}>{sig.status}</span>
                    {sig.subject?.suspended && (
                      <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">subject suspended</span>
                    )}
                  </div>
                  <p className="truncate text-sm font-medium">{userLabel(sig.subject, sig.subjectUserId)}</p>
                  <p className="text-xs text-muted-foreground">
                    {sig.signalType === "phash_collision" && sig.counterpart
                      ? `Reused ${(sig.evidence.reused_count as number) ?? 0} photo(s) from ${userLabel(sig.counterpart, (sig.evidence.counterpart_user_id as string) ?? "")}`
                      : sig.signalType === "submission_velocity"
                      ? `${(sig.evidence.count as number) ?? 0} submissions in ${(sig.evidence.window_hours as number) ?? 24}h`
                      : "—"}
                    {" · "}last seen {new Date(sig.lastSeenAt).toLocaleString()}
                  </p>
                </div>
                <Eye className="h-4 w-4 shrink-0 text-muted-foreground" />
              </CardContent>
            </Card>
          ))}

          {/* Pagination */}
          <div className="flex items-center justify-between pt-2 text-sm text-muted-foreground">
            <span>{data?.total ?? 0} signal(s)</span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page <= 1 || query.isFetching} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span>Page {data?.page ?? 1} / {data?.totalPages ?? 1}</span>
              <Button variant="outline" size="sm" disabled={page >= (data?.totalPages ?? 1) || query.isFetching} onClick={() => setPage((p) => p + 1)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Detail drawer */}
      <Sheet open={!!selected} onOpenChange={(o) => { if (!o) { setSelected(null); setReason(""); } }}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  {TYPE_LABEL[selected.signalType]}
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${SEVERITY_BADGE[selected.severity]}`}>{selected.severity}</span>
                </SheetTitle>
                <SheetDescription>
                  Status: <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_BADGE[selected.status]}`}>{selected.status}</span>
                  {" · "}First seen {new Date(selected.firstSeenAt).toLocaleString()}
                </SheetDescription>
              </SheetHeader>

              <div className="mt-6 space-y-5 px-1">
                {/* Implicated accounts */}
                <div className="space-y-2">
                  <Label className="text-xs uppercase text-muted-foreground">Implicated accounts</Label>
                  <div className="rounded-md border p-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">Subject</span>
                      <Link to={`/admin/users/${selected.subjectUserId}`} className="inline-flex items-center gap-1 text-brand-red-text hover:underline">
                        {userLabel(selected.subject, selected.subjectUserId)} <ExternalLink className="h-3 w-3" />
                      </Link>
                    </div>
                    {selected.counterpart && (
                      <div className="mt-2 flex items-center justify-between gap-2 border-t pt-2">
                        <span className="font-medium">Counterpart</span>
                        <Link to={`/admin/users/${selected.counterpart.userId}`} className="inline-flex items-center gap-1 text-brand-red-text hover:underline">
                          {userLabel(selected.counterpart, selected.counterpart.userId)} <ExternalLink className="h-3 w-3" />
                        </Link>
                      </div>
                    )}
                  </div>
                </div>

                {/* Evidence (ids/hashes/counts only — never image bytes) */}
                <div className="space-y-2">
                  <Label className="text-xs uppercase text-muted-foreground">Evidence</Label>
                  <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 text-xs">
                    {JSON.stringify(selected.evidence, null, 2)}
                  </pre>
                </div>

                {selected.resolutionReason && (
                  <div className="space-y-1 text-sm">
                    <Label className="text-xs uppercase text-muted-foreground">Resolution</Label>
                    <p>{selected.resolutionReason}</p>
                  </div>
                )}

                {/* Actions */}
                {selected.status !== "actioned" && selected.status !== "dismissed" && (
                  <div className="space-y-3 border-t pt-4">
                    {selected.status === "open" && (
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => setSignalStatus(selected, "reviewing")}>
                        <Eye className="h-3.5 w-3.5" /> Start reviewing
                      </Button>
                    )}

                    <div className="space-y-1.5">
                      <Label className="text-xs">Resolution reason (required to action/dismiss)</Label>
                      <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Why are you resolving this signal?" />
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" disabled={busy} onClick={() => setSignalStatus(selected, "actioned")}>
                        Mark actioned
                      </Button>
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => setSignalStatus(selected, "dismissed")}>
                        Dismiss
                      </Button>
                    </div>

                    <div className="space-y-2 border-t pt-4">
                      <Label className="text-xs uppercase text-muted-foreground">Enforcement</Label>
                      <div className="flex flex-wrap gap-2">
                        {!selected.subject?.suspended && (
                          <Button variant="outline" size="sm" disabled={busy} onClick={() => suspendSubject(selected)}>
                            <Ban className="h-3.5 w-3.5 text-destructive" /> Suspend subject
                          </Button>
                        )}
                        {subjectSubmissionId && (
                          <Button variant="outline" size="sm" disabled={busy} onClick={() => voidGrade(subjectSubmissionId)}>
                            <XCircle className="h-3.5 w-3.5 text-destructive" /> Void this grade
                          </Button>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Suspending and voiding reuse the audited moderation endpoints and require a fresh second factor.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <MfaStepUpDialog open={stepUpOpen} onOpenChange={setStepUpOpen} onVerified={() => retry?.()} />
    </div>
  );
}
