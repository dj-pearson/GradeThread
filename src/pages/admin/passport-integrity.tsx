import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import { PageHeader } from "@/components/ui/page-header";
import { ErrorState } from "@/components/ui/error-state";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
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
  ShieldCheck,
  RefreshCw,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Eye,
  ExternalLink,
  Scissors,
  MessageSquarePlus,
  Play,
} from "lucide-react";

// US-1103 — Garment Passport integrity & fraud console.
//
// Lists the durable anomalies the passport-integrity-scan cron persists (wear
// reversal, duplicate fingerprint across owners, rapid re-claim, token replay),
// with a detail drawer. Triage moves a signal open -> reviewing ->
// actioned/dismissed (PATCH; resolving requires a fresh MFA step-up). Admin
// actions: annotate (POST /notes) and sever a probable link (POST /sever;
// super_admin + step-up) — which drops a fraudulent link from the public chain.

type SignalType = "wear_reversal" | "duplicate_fingerprint" | "rapid_reclaim" | "token_replay";
type Severity = "low" | "medium" | "high" | "critical";
type Status = "open" | "reviewing" | "actioned" | "dismissed";

interface GarmentLite {
  garmentId: string;
  slug: string | null;
  skuClass: Record<string, unknown>;
  status: string;
}

interface NoteEntry {
  by: string;
  at: string;
  text: string;
}

interface Signal {
  id: string;
  signalType: SignalType;
  severity: Severity;
  status: Status;
  garmentId: string;
  garment: GarmentLite | null;
  counterpartGarment: GarmentLite | null;
  evidence: Record<string, unknown>;
  notes: NoteEntry[];
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

interface LinkEvent {
  id: string;
  eventType: string;
  confidence: string;
  source: string | null;
  createdAt: string;
}

interface DetailResponse {
  signal: Signal;
  links: LinkEvent[];
}

const TYPE_LABEL: Record<SignalType, string> = {
  wear_reversal: "Wear reversal",
  duplicate_fingerprint: "Duplicate fingerprint",
  rapid_reclaim: "Rapid re-claim",
  token_replay: "Token replay",
};

const TYPE_BLURB: Record<SignalType, string> = {
  wear_reversal: "Condition improved across a same-item link (impossible without a swap).",
  duplicate_fingerprint: "Same fingerprint on two active garments held by different owners.",
  rapid_reclaim: "Passport reclaimed many times in a short window.",
  token_replay: "Repeated redemption attempts against a used/expired claim token.",
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

function skuLabel(g: GarmentLite | null): string {
  if (!g) return "Unknown garment";
  const sku = g.skuClass ?? {};
  const parts = ["brand", "garment_type", "size", "colorway"]
    .map((k) => sku[k])
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  return parts.length > 0 ? parts.join(" · ") : (g.slug ? `Passport ${g.slug.slice(0, 8)}…` : "Garment");
}

function summarize(sig: Signal): string {
  const e = sig.evidence ?? {};
  switch (sig.signalType) {
    case "wear_reversal":
      return `Condition improved ${(e.drop as number) ?? "?"} pts (wear ${e.from_wear_score} → ${e.to_wear_score})`;
    case "duplicate_fingerprint":
      return `${(e.matches as unknown[])?.length ?? 0} matching photo(s) on another active owner's garment`;
    case "rapid_reclaim":
      return `${(e.reclaim_count as number) ?? 0} claims in ${(e.window_hours as number) ?? 72}h`;
    case "token_replay":
      return `${(e.rejected_count as number) ?? 0} rejected redemption attempts`;
    default:
      return "—";
  }
}

export function AdminPassportIntegrityPage() {
  const [type, setType] = useState<string>("all");
  const [severity, setSeverity] = useState<string>("all");
  const [status, setStatus] = useState<string>("open");
  const [page, setPage] = useState(1);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [noteText, setNoteText] = useState("");
  const [severReason, setSeverReason] = useState("");
  // US-2335: ids for the label/control pairs below.
  const statusFilterId = useId();
  const typeFilterId = useId();
  const severityFilterId = useId();
  const resolutionId = useId();
  const [busy, setBusy] = useState(false);

  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [retry, setRetry] = useState<null | (() => void)>(null);

  const qs = new URLSearchParams({ status, page: String(page), page_size: "25" });
  if (type !== "all") qs.set("type", type);
  if (severity !== "all") qs.set("severity", severity);

  const query = useQuery({
    queryKey: ["admin-passport-integrity", status, type, severity, page],
    queryFn: () => getJson<SignalsResponse>(`/api/admin/passport-integrity/signals?${qs.toString()}`),
  });

  const detail = useQuery({
    queryKey: ["admin-passport-integrity-detail", selectedId],
    queryFn: () => getJson<DetailResponse>(`/api/admin/passport-integrity/signals/${selectedId}`),
    enabled: !!selectedId,
  });

  const selected = detail.data?.signal ?? null;
  const links = detail.data?.links ?? [];

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
      void detail.refetch();
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
      `/api/admin/passport-integrity/signals/${sig.id}`,
      "PATCH",
      { status: next, reason: reason.trim() || undefined },
      next === "reviewing" ? "Marked reviewing" : `Signal ${next}`,
      () => setReason(""),
    );
  }

  function addNote(sig: Signal) {
    if (!noteText.trim()) {
      toast.error("Write a note first.");
      return;
    }
    void call(
      `/api/admin/passport-integrity/signals/${sig.id}/notes`,
      "POST",
      { text: noteText.trim() },
      "Annotation added",
      () => setNoteText(""),
    );
  }

  function severLink(sig: Signal, eventId: string) {
    if (!severReason.trim()) {
      toast.error("Add a reason to sever this link.");
      return;
    }
    void call(
      `/api/admin/passport-integrity/signals/${sig.id}/sever`,
      "POST",
      { event_id: eventId, reason: severReason.trim() },
      "Link severed — removed from the public chain",
      () => setSeverReason(""),
    );
  }

  function runScan() {
    void call(
      `/api/admin/passport-integrity/scan`,
      "POST",
      {},
      "Integrity scan complete",
    );
  }

  const data = query.data;
  const signals = data?.signals ?? [];

  function changeFilter(setter: (v: string) => void, v: string) {
    setter(v);
    setPage(1);
  }

  function closeDrawer() {
    setSelectedId(null);
    setReason("");
    setNoteText("");
    setSeverReason("");
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Passport Integrity"
        subtitle="Ledger-integrity anomalies — impossible chains, duplicate fingerprints, claim abuse — to keep the Garment Passport trustworthy. Resolving or severing a link requires a fresh second factor."
        icon={ShieldCheck}
        actions={
          <>
            <Button variant="outline" size="sm" onClick={runScan} disabled={busy}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Run scan
            </Button>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>
              {query.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </Button>
          </>
        }
      />

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor={statusFilterId}>Status</Label>
          <Select value={status} onValueChange={(v) => changeFilter(setStatus, v)}>
            <SelectTrigger className="w-36" id={statusFilterId}><SelectValue /></SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor={typeFilterId}>Type</Label>
          <Select value={type} onValueChange={(v) => changeFilter(setType, v)}>
            <SelectTrigger className="w-52" id={typeFilterId}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {(Object.keys(TYPE_LABEL) as SignalType[]).map((t) => (
                <SelectItem key={t} value={t}>{TYPE_LABEL[t]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor={severityFilterId}>Severity</Label>
          <Select value={severity} onValueChange={(v) => changeFilter(setSeverity, v)}>
            <SelectTrigger className="w-36" id={severityFilterId}><SelectValue /></SelectTrigger>
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
            No integrity anomalies match these filters. The scan runs on a schedule; use “Run scan” to
            check now.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {signals.map((sig) => (
            <Card
              key={sig.id}
              role="button"
              tabIndex={0}
              aria-label={`View ${TYPE_LABEL[sig.signalType]} signal`}
              className="cursor-pointer transition-colors hover:border-brand-red/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => { setSelectedId(sig.id); setReason(""); setNoteText(""); setSeverReason(""); }}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                setSelectedId(sig.id); setReason(""); setNoteText(""); setSeverReason("");
              }}
            >
              <CardContent className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{TYPE_LABEL[sig.signalType]}</Badge>
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${SEVERITY_BADGE[sig.severity]}`}>{sig.severity}</span>
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[sig.status]}`}>{sig.status}</span>
                  </div>
                  <p className="truncate text-sm font-medium">{skuLabel(sig.garment)}</p>
                  <p className="text-xs text-muted-foreground">
                    {summarize(sig)}
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
      <Sheet open={!!selectedId} onOpenChange={(o) => { if (!o) closeDrawer(); }}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          {/* US-2507: isError first — `!selected` is also true on a failed
              load, so the drawer would spin forever instead of saying why. */}
          {detail.isError ? (
            <div className="pt-8">
              <ErrorState
                title="Couldn't load this signal"
                description="It's still recorded — we just couldn't fetch the detail right now."
                onRetry={() => void detail.refetch()}
                retrying={detail.isFetching}
              />
            </div>
          ) : detail.isLoading || !selected ? (
            <div className="space-y-3 pt-8">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16" />)}
            </div>
          ) : (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  {TYPE_LABEL[selected.signalType]}
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${SEVERITY_BADGE[selected.severity]}`}>{selected.severity}</span>
                </SheetTitle>
                <SheetDescription>
                  {TYPE_BLURB[selected.signalType]}
                  {" "}Status: <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_BADGE[selected.status]}`}>{selected.status}</span>
                  {" · "}First seen {new Date(selected.firstSeenAt).toLocaleString()}
                </SheetDescription>
              </SheetHeader>

              <div className="mt-6 space-y-5 px-1">
                {/* Implicated garments */}
                <div className="space-y-2">
                  <Label className="text-xs uppercase text-muted-foreground">Garment</Label>
                  <div className="rounded-md border p-3 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{skuLabel(selected.garment)}</span>
                      {selected.garment?.slug && (
                        <a href={`/passport/${selected.garment.slug}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-red-text hover:underline">
                          Passport <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                    {selected.counterpartGarment && (
                      <div className="mt-2 flex items-center justify-between gap-2 border-t pt-2">
                        <span className="font-medium">Counterpart: {skuLabel(selected.counterpartGarment)}</span>
                        {selected.counterpartGarment.slug && (
                          <a href={`/passport/${selected.counterpartGarment.slug}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-red-text hover:underline">
                            Passport <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Evidence (ids/hashes/counts only — never image bytes) */}
                <div className="space-y-2">
                  <Label className="text-xs uppercase text-muted-foreground">Evidence</Label>
                  <pre className="max-h-56 overflow-auto rounded-md border bg-muted/40 p-3 text-xs">
                    {JSON.stringify(selected.evidence, null, 2)}
                  </pre>
                </div>

                {/* Notes (annotations) */}
                <div className="space-y-2">
                  <Label className="text-xs uppercase text-muted-foreground">Notes</Label>
                  {selected.notes.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No annotations yet.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {selected.notes.map((n, i) => (
                        <li key={i} className="rounded-md border bg-muted/20 p-2 text-xs">
                          <p>{n.text}</p>
                          <p className="mt-1 text-muted-foreground">{new Date(n.at).toLocaleString()}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex items-start gap-2">
                    {/* US-2335: placeholder-only. A placeholder is not an
                        accessible name — it vanishes on first keystroke, so a
                        half-typed field announces nothing at all. */}
                    <Input
                      aria-label="Annotation"
                      value={noteText}
                      onChange={(e) => setNoteText(e.target.value)}
                      placeholder="Add an annotation…"
                      className="text-sm"
                    />
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => addNote(selected)}>
                      <MessageSquarePlus className="h-3.5 w-3.5" /> Add
                    </Button>
                  </div>
                </div>

                {selected.resolutionReason && (
                  <div className="space-y-1 text-sm">
                    <Label className="text-xs uppercase text-muted-foreground">Resolution</Label>
                    <p>{selected.resolutionReason}</p>
                  </div>
                )}

                {/* Sever a probable link */}
                {links.length > 0 && (
                  <div className="space-y-2 border-t pt-4">
                    <Label className="text-xs uppercase text-muted-foreground">Sever a probable link</Label>
                    <p className="text-xs text-muted-foreground">
                      Severing drops a fraudulent ownership/listing link from the public passport chain.
                      Requires super_admin + a fresh second factor.
                    </p>
                    {/* The Label above names the whole SECTION ("Sever a
                        probable link"), not this field, so attaching it here
                        would announce the section heading as the field name. */}
                    <Textarea
                      aria-label="Reason for severing this link"
                      value={severReason}
                      onChange={(e) => setSeverReason(e.target.value)}
                      rows={2}
                      placeholder="Why is this link being severed?"
                    />
                    <ul className="space-y-1.5">
                      {links.map((lk) => (
                        <li key={lk.id} className="flex items-center justify-between gap-2 rounded-md border p-2 text-xs">
                          <span>
                            <span className="font-medium">{lk.eventType}</span>
                            {" · "}{lk.confidence}
                            {" · "}{new Date(lk.createdAt).toLocaleDateString()}
                          </span>
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => severLink(selected, lk.id)}>
                          aria-label={`Sever the ${lk.eventType} link`}
                            <Scissors className="h-3.5 w-3.5 text-destructive" /> Sever
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Triage actions */}
                {selected.status !== "actioned" && selected.status !== "dismissed" && (
                  <div className="space-y-3 border-t pt-4">
                    {selected.status === "open" && (
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => setSignalStatus(selected, "reviewing")}>
                        <Eye className="h-3.5 w-3.5" /> Start reviewing
                      </Button>
                    )}
                    <div className="space-y-1.5">
                      <Label className="text-xs" htmlFor={resolutionId}>Resolution reason (required to action/dismiss)</Label>
                      <Textarea id={resolutionId} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Why are you resolving this signal?" />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" disabled={busy} onClick={() => setSignalStatus(selected, "actioned")}>
                        Mark actioned
                      </Button>
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => setSignalStatus(selected, "dismissed")}>
                        Dismiss
                      </Button>
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
