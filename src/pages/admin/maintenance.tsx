import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Wrench, RefreshCw, Loader2, Plus, Power, Trash2, CalendarClock } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";

// US-887 — maintenance mode + scheduled maintenance windows.
//
// Schedule/activate a window over a scope (platform | grading | flipdesk |
// checkout) in a mode (banner | read_only | blocked), immediately or on a
// schedule. Creating, editing-active, and deleting all PUT/POST/PATCH/DELETE
// /api/admin/ops/maintenance — super_admin + a fresh MFA step-up server-side.
// "End now" immediately clears an active window.

type Scope = "platform" | "grading" | "flipdesk" | "checkout";
type Mode = "banner" | "read_only" | "blocked";

interface MaintenanceWindow {
  id: string;
  scope: Scope;
  mode: Mode;
  message: string;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const SCOPES: Scope[] = ["platform", "grading", "flipdesk", "checkout"];
const MODES: Mode[] = ["banner", "read_only", "blocked"];

const MODE_HELP: Record<Mode, string> = {
  banner: "Informational only — a dismissible notice, no enforcement.",
  read_only: "Rejects writes for non-admins; reads keep working.",
  blocked: "Returns 503 for all in-scope non-admin requests.",
};

const MODE_BADGE: Record<Mode, string> = {
  banner: "bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-200",
  read_only: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
  blocked: "bg-brand-red/15 text-brand-red-text",
};

async function getJson<T>(path: string): Promise<T> {
  const res = await edgeFetch(path, { silentGate: true });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body as T;
}

// datetime-local value → ISO (or null when empty).
function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isEffectiveNow(w: MaintenanceWindow): boolean {
  if (!w.is_active) return false;
  const now = Date.now();
  if (w.starts_at && Date.parse(w.starts_at) > now) return false;
  if (w.ends_at && Date.parse(w.ends_at) <= now) return false;
  return true;
}

export function AdminMaintenancePage() {
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [retry, setRetry] = useState<null | (() => void)>(null);
  const [busy, setBusy] = useState(false);

  // Create-form state.
  const [scope, setScope] = useState<Scope>("platform");
  const [mode, setMode] = useState<Mode>("banner");
  const [message, setMessage] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  // US-2335: label/control ids. useId rather than slugs — "Starts at" and
  // "Ends at" are common enough field names that a slug would collide with
  // another form on a shared layout, and a duplicate id points a label at the
  // wrong control while still reading as correct.
  const scopeId = useId();
  const modeId = useId();
  const messageId = useId();
  const startsAtId = useId();
  const endsAtId = useId();

  const query = useQuery({
    queryKey: ["admin-maintenance-windows"],
    queryFn: () => getJson<{ windows: MaintenanceWindow[] }>("/api/admin/ops/maintenance"),
  });

  function handleStepUp(retryFn: () => void) {
    setRetry(() => retryFn);
    setStepUpOpen(true);
  }

  // One mutate helper handles the step-up retry dance for every write.
  async function mutate(
    path: string,
    method: "POST" | "PATCH" | "DELETE",
    json: unknown,
    okMsg: string,
    onDone?: () => void,
  ) {
    setBusy(true);
    try {
      const res = await edgeFetch(path, { method, json, silentGate: true });
      const j = await res.json().catch(() => ({}));
      if (res.status === 403 && (j as { code?: string })?.code === "STEP_UP_REQUIRED") {
        handleStepUp(() => void mutate(path, method, json, okMsg, onDone));
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

  function createWindow() {
    if (!message.trim()) {
      toast.error("A message is required.");
      return;
    }
    const start = fromLocalInput(startsAt);
    const end = fromLocalInput(endsAt);
    if (start && end && Date.parse(end) <= Date.parse(start)) {
      toast.error("End time must be after the start time.");
      return;
    }
    void mutate(
      "/api/admin/ops/maintenance",
      "POST",
      { scope, mode, message: message.trim(), starts_at: start, ends_at: end, is_active: true },
      "Maintenance window created",
      () => {
        setMessage("");
        setStartsAt("");
        setEndsAt("");
      },
    );
  }

  function endNow(w: MaintenanceWindow) {
    void mutate(
      `/api/admin/ops/maintenance/${w.id}`,
      "PATCH",
      { is_active: false },
      "Maintenance window ended",
    );
  }

  function reactivate(w: MaintenanceWindow) {
    void mutate(
      `/api/admin/ops/maintenance/${w.id}`,
      "PATCH",
      { is_active: true },
      "Maintenance window activated",
    );
  }

  function remove(w: MaintenanceWindow) {
    void mutate(
      `/api/admin/ops/maintenance/${w.id}`,
      "DELETE",
      undefined,
      "Maintenance window deleted",
    );
  }

  const windows = query.data?.windows ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Maintenance Windows"
        subtitle="Put the platform or a subsystem into maintenance — now or on a schedule. Admins always bypass enforcement. Changes are audited and require a fresh second factor."
        icon={Wrench}
        actions={
          <Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>
            {query.isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </Button>
        }
      />

      {/* Create / schedule */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Schedule a window</CardTitle>
          <CardDescription>
            Leave the start blank to begin immediately. Leave the end blank for an open-ended window
            you close with “End now”.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={scopeId}>Scope</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as Scope)}>
                <SelectTrigger id={scopeId}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SCOPES.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={modeId}>Mode</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
                <SelectTrigger id={modeId}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {MODES.map((m) => (
                    <SelectItem key={m} value={m}>{m}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{MODE_HELP[mode]}</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={messageId}>Message (shown to users)</Label>
            <Textarea
              id={messageId}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
              placeholder="We’re performing scheduled maintenance and will be back shortly."
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={startsAtId}>Starts at (optional)</Label>
              <Input id={startsAtId} type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={endsAtId}>Ends at (optional)</Label>
              <Input id={endsAtId} type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
            </div>
          </div>

          <Button onClick={createWindow} disabled={busy || !message.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Create window
          </Button>
        </CardContent>
      </Card>

      {/* Existing windows */}
      {query.isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-28" />)}
        </div>
      ) : query.isError ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-destructive">
            {(query.error as Error)?.message ?? "Failed to load maintenance windows."}
          </CardContent>
        </Card>
      ) : windows.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            No maintenance windows. Schedule one above.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {windows.map((w) => {
            const effective = isEffectiveNow(w);
            const scheduled = w.is_active && !effective && w.starts_at && Date.parse(w.starts_at) > Date.now();
            return (
              <Card key={w.id} className={effective ? "border-brand-red/40" : undefined}>
                <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="uppercase">{w.scope}</Badge>
                      <span className={`rounded px-2 py-0.5 text-xs font-medium ${MODE_BADGE[w.mode]}`}>
                        {w.mode}
                      </span>
                      {effective && (
                        <span className="rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-950/40 dark:text-green-200">
                          Active now
                        </span>
                      )}
                      {scheduled && (
                        <span className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                          <CalendarClock className="h-3 w-3" /> Scheduled
                        </span>
                      )}
                      {!w.is_active && (
                        <span className="rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                          Ended
                        </span>
                      )}
                    </div>
                    <p className="text-sm">{w.message}</p>
                    <p className="text-xs text-muted-foreground">
                      {w.starts_at ? `From ${new Date(w.starts_at).toLocaleString()}` : "Immediate"}
                      {" · "}
                      {w.ends_at ? `until ${new Date(w.ends_at).toLocaleString()}` : "open-ended"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {w.is_active ? (
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => endNow(w)}>
                      aria-label={`End the window now: ${w.message}`}
                        <Power className="h-3.5 w-3.5" /> End now
                      </Button>
                    ) : (
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => reactivate(w)}>
                      aria-label={`Activate the window: ${w.message}`}
                        <Power className="h-3.5 w-3.5" /> Activate
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => remove(w)} title="Delete">
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <MfaStepUpDialog open={stepUpOpen} onOpenChange={setStepUpOpen} onVerified={() => retry?.()} />
    </div>
  );
}
