import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { MfaStepUpDialog } from "@/components/admin/admin-mfa-gate";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  Mailbox,
  Power,
  PowerOff,
  RefreshCw,
  ShieldAlert,
  Sparkles,
} from "lucide-react";

// ── Types (mirror the /api/admin/journeys payload) ───────────────────────────

interface JourneyStep {
  step_order: number;
  offset_days: number;
  subject: string;
  cta_label: string | null;
  cta_url: string | null;
  ai_personalize: boolean;
  enabled: boolean;
  sent: number;
  skipped: number;
}

interface JourneyEnrollments {
  active: number;
  completed: number;
  exited: number;
  total: number;
}

interface Journey {
  id: string;
  journey_key: string;
  name: string;
  description: string;
  trigger: string;
  email_class: string;
  trigger_window_days: number;
  enabled: boolean;
  steps: JourneyStep[];
  enrollments: JourneyEnrollments;
}

interface JourneysPayload {
  journeys: Journey[];
  killSwitchEnabled: boolean;
}

const TRIGGER_LABEL: Record<string, string> = {
  signup: "On signup",
  trial_ending: "Trial ending soon",
  inactivity: "Inactivity",
  first_grade: "First grade",
  first_sale: "First sale",
};

export function AdminJourneysPage() {
  const qc = useQueryClient();
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [retry, setRetry] = useState<null | (() => void)>(null);

  const journeys = useQuery({
    queryKey: ["admin-journeys"],
    queryFn: async (): Promise<JourneysPayload> => {
      const res = await edgeFetch("/api/admin/journeys");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed to load journeys");
      return json as JourneysPayload;
    },
    staleTime: 15_000,
  });

  // Step-up-aware runner: retries the same call after a fresh MFA verify.
  async function run(doFetch: () => Promise<Response>): Promise<unknown | null> {
    const res = await doFetch();
    if (res.status === 403) {
      const j = await res.json().catch(() => ({}));
      if ((j as { code?: string })?.code === "STEP_UP_REQUIRED") {
        setRetry(() => () => void run(doFetch));
        setStepUpOpen(true);
        return null;
      }
      toast.error((j as { error?: string })?.error ?? "Forbidden");
      return null;
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error((j as { error?: string })?.error ?? "Action failed");
      return null;
    }
    return j;
  }

  const toggle = useMutation({
    mutationFn: (vars: { id: string; enabled: boolean }) =>
      run(() =>
        edgeFetch(`/api/admin/journeys/${vars.id}`, {
          method: "PATCH",
          json: { enabled: vars.enabled },
        })
      ),
    onSuccess: (r) => {
      if (r) {
        toast.success("Journey updated");
        void qc.invalidateQueries({ queryKey: ["admin-journeys"] });
      }
    },
  });

  const data = journeys.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Mailbox className="h-6 w-6 text-brand-red-text" />
          <div>
            <h1 className="text-2xl font-bold">Lifecycle Journeys</h1>
            <p className="text-sm text-muted-foreground">
              Automated email series triggered by user state — welcome,
              trial-ending nurture, and win-back. Enable each one to start sending.
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void journeys.refetch()}
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      {data && !data.killSwitchEnabled && (
        <Card className="border-amber-500/40 bg-amber-50/50">
          <CardContent className="flex items-center gap-3 py-4 text-sm">
            <ShieldAlert className="h-5 w-5 text-amber-600" />
            <span>
              The platform-wide <strong>lifecycle_journeys</strong> kill-switch is
              OFF. No journeys will send until it's re-enabled from Feature Flags.
            </span>
          </CardContent>
        </Card>
      )}

      {journeys.isLoading && (
        <div className="space-y-4">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      )}

      {journeys.isError && (
        <Card>
          <CardContent className="py-6 text-sm text-destructive">
            {(journeys.error as Error)?.message ?? "Failed to load journeys"}
          </CardContent>
        </Card>
      )}

      {data?.journeys.map((j) => (
        <Card key={j.id}>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  {j.name}
                  <Badge variant={j.enabled ? "default" : "secondary"}>
                    {j.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                </CardTitle>
                <CardDescription className="mt-1 max-w-2xl">
                  {j.description}
                </CardDescription>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="outline">
                    {TRIGGER_LABEL[j.trigger] ?? j.trigger}
                  </Badge>
                  <Badge variant="outline">
                    {j.email_class === "marketing" ? "Marketing" : "Transactional"}
                  </Badge>
                  <Badge variant="outline">
                    Window: {j.trigger_window_days}d
                  </Badge>
                </div>
              </div>
              <Button
                variant={j.enabled ? "outline" : "default"}
                size="sm"
                disabled={toggle.isPending}
                onClick={() => toggle.mutate({ id: j.id, enabled: !j.enabled })}
              >
                {j.enabled ? (
                  <>
                    <PowerOff className="mr-2 h-4 w-4" />
                    Disable
                  </>
                ) : (
                  <>
                    <Power className="mr-2 h-4 w-4" />
                    Enable
                  </>
                )}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-4 text-sm">
              <span>
                <span className="font-semibold">{j.enrollments.active}</span>{" "}
                <span className="text-muted-foreground">active</span>
              </span>
              <span>
                <span className="font-semibold">{j.enrollments.completed}</span>{" "}
                <span className="text-muted-foreground">completed</span>
              </span>
              <span>
                <span className="font-semibold">{j.enrollments.exited}</span>{" "}
                <span className="text-muted-foreground">exited</span>
              </span>
              <span>
                <span className="font-semibold">{j.enrollments.total}</span>{" "}
                <span className="text-muted-foreground">total enrolled</span>
              </span>
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">#</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead className="w-20 text-right">Day</TableHead>
                  <TableHead className="w-20 text-right">Sent</TableHead>
                  <TableHead className="w-20 text-right">Skipped</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {j.steps.map((s) => (
                  <TableRow key={s.step_order}>
                    <TableCell>{s.step_order}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span>{s.subject}</span>
                        {s.ai_personalize && (
                          <Sparkles
                            className="h-3.5 w-3.5 text-brand-red-text"
                            aria-label="AI-personalized"
                          />
                        )}
                        {!s.enabled && (
                          <Badge variant="secondary" className="text-[10px]">
                            off
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      +{s.offset_days}
                    </TableCell>
                    <TableCell className="text-right font-medium">{s.sent}</TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {s.skipped}
                    </TableCell>
                  </TableRow>
                ))}
                {j.steps.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      No steps configured.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}

      <MfaStepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => {
          setStepUpOpen(false);
          retry?.();
        }}
      />
    </div>
  );
}
