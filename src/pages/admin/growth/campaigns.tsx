import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useDocumentVisible } from "@/hooks/use-document-visible";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/ui/page-header";
import { useConfirm } from "@/components/ui/confirm-dialog";
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
import { Plus, Send, Trash2, Mail, Bell, Smartphone } from "lucide-react";

type Channel = "email" | "in_app" | "push";

interface Campaign {
  id: string;
  name: string;
  subject: string;
  body: string;
  cta_label: string | null;
  cta_url: string | null;
  channels: Channel[];
  segment_id: string | null;
  status: string;
  scheduled_for: string | null;
  sent_at: string | null;
  stats: Record<string, number>;
}
interface Segment { id: string; name: string }

const STATUS_COLOR: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  scheduled: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
  sending: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
  sent: "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300",
  canceled: "bg-slate-100 text-slate-500",
};
const CHANNEL_ICON: Record<Channel, typeof Mail> = {
  email: Mail,
  in_app: Bell,
  push: Smartphone,
};

function ComposeDialog({
  open,
  onOpenChange,
  segments,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  segments: Segment[];
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [ctaLabel, setCtaLabel] = useState("");
  const [ctaUrl, setCtaUrl] = useState("");
  const [channels, setChannels] = useState<Channel[]>(["in_app"]);
  const [segmentId, setSegmentId] = useState<string>("all");
  const [scheduledFor, setScheduledFor] = useState("");

  const toggleChannel = (ch: Channel) =>
    setChannels((cur) => (cur.includes(ch) ? cur.filter((c) => c !== ch) : [...cur, ch]));

  const create = useMutation({
    mutationFn: async () => {
      const res = await edgeFetch("/api/admin/growth/campaigns", {
        method: "POST",
        json: {
          name,
          subject,
          body,
          cta_label: ctaLabel || null,
          cta_url: ctaUrl || null,
          channels,
          segment_id: segmentId === "all" ? null : segmentId,
          scheduled_for: scheduledFor ? new Date(scheduledFor).toISOString() : null,
        },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Create failed");
      return json;
    },
    onSuccess: () => {
      toast.success("Campaign saved as draft");
      qc.invalidateQueries({ queryKey: ["growth-campaigns"] });
      onOpenChange(false);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New campaign</DialogTitle>
          <DialogDescription>
            Compose once, deliver across the channels you select. Saved as a draft —
            you send it from the list.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="c-internal-name">Internal name</Label>
            <Input id="c-internal-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Spring promo blast" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="c-subject-title">Subject / title</Label>
            <Input id="c-subject-title" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Email subject & push/in-app title" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="c-message">Message</Label>
            <Textarea id="c-message" value={body} onChange={(e) => setBody(e.target.value)} rows={5} placeholder="Body text. Blank lines split paragraphs." />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="c-button-label-optional">Button label (optional)</Label>
              <Input id="c-button-label-optional" value={ctaLabel} onChange={(e) => setCtaLabel(e.target.value)} placeholder="Shop now" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="c-button-url-optional">Button URL (optional)</Label>
              <Input id="c-button-url-optional" value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} placeholder="https://gradethread.com/…" />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Channels</Label>
            <div className="flex gap-2">
              {(["email", "in_app", "push"] as Channel[]).map((ch) => {
                const Icon = CHANNEL_ICON[ch];
                const on = channels.includes(ch);
                return (
                  <Button
                    key={ch}
                    type="button"
                    variant={on ? "default" : "outline"}
                    size="sm"
                    onClick={() => toggleChannel(ch)}
                  >
                    <Icon className="mr-1 h-4 w-4" />
                    {ch === "in_app" ? "In-app" : ch.charAt(0).toUpperCase() + ch.slice(1)}
                  </Button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="c-audience">Audience</Label>
              <Select value={segmentId} onValueChange={setSegmentId}>
                <SelectTrigger id="c-audience"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Everyone</SelectItem>
                  {segments.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="c-schedule-optional">Schedule (optional)</Label>
              <Input id="c-schedule-optional" type="datetime-local" value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => create.mutate()}
            disabled={!name.trim() || !subject.trim() || !body.trim() || channels.length === 0 || create.isPending}
          >
            {create.isPending ? "Saving…" : "Save draft"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function GrowthCampaignsPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  // US-2197: don't poll every 15s while the tab is backgrounded.
  const visible = useDocumentVisible();
  const [composeOpen, setComposeOpen] = useState(false);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [pendingSendId, setPendingSendId] = useState<string | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ["growth-campaigns"],
    queryFn: async (): Promise<{ campaigns: Campaign[] }> => {
      const res = await edgeFetch("/api/admin/growth/campaigns");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load campaigns");
      return json;
    },
    refetchInterval: visible ? 15_000 : false,
  });

  const { data: segData } = useQuery({
    queryKey: ["growth-segments"],
    queryFn: async (): Promise<{ segments: Segment[] }> => {
      const res = await edgeFetch("/api/admin/growth/segments");
      return res.ok ? res.json() : { segments: [] };
    },
  });

  async function doSend(id: string) {
    if (sendingId) return;
    setSendingId(id);
    try {
    const res = await edgeFetch(`/api/admin/growth/campaigns/${id}/send`, {
      method: "POST",
      json: {},
      silentGate: true,
    });
    if (res.status === 403) {
      const j = await res.json().catch(() => ({}));
      if (j?.code === "STEP_UP_REQUIRED") {
        setPendingSendId(id);
        setStepUpOpen(true);
        return;
      }
      toast.error(j?.error ?? "Forbidden");
      return;
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(j.error ?? "Send failed");
      return;
    }
    const s = j.stats ?? {};
    toast.success(
      `Sent — email ${s.sent_email ?? 0}, in-app ${s.sent_in_app ?? 0}, push ${s.sent_push ?? 0}`,
    );
    qc.invalidateQueries({ queryKey: ["growth-campaigns"] });
    } finally {
      setSendingId(null);
    }
  }

  const del = useMutation({
    mutationFn: async (id: string) => {
      const res = await edgeFetch(`/api/admin/growth/campaigns/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Delete failed");
    },
    onSuccess: () => {
      toast.success("Campaign deleted");
      qc.invalidateQueries({ queryKey: ["growth-campaigns"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Campaigns"
        subtitle={
          <>
            Broadcast across email, in-app, and push. Sending requires a super-admin
            MFA step-up.
          </>
        }
        actions={
          <Button onClick={() => setComposeOpen(true)}><Plus className="mr-1 h-4 w-4" /> New campaign</Button>
        }
      />

      {isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : isError ? (
        /* US-2507: BEFORE the empty branch — "No campaigns yet" on a failed
           load invites an operator to recreate one that already exists. */
        <Card>
          <CardContent className="p-0">
            <ErrorState
              className="py-10"
              title="Couldn't load campaigns"
              description="They're still there — we just couldn't fetch them right now."
              onRetry={() => void refetch()}
              retrying={isFetching}
            />
          </CardContent>
        </Card>
      ) : !data || data.campaigns.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Send}
              title="No campaigns yet"
              description="Create a campaign to reach a segment by email, in-app, or push."
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Channels</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Delivered</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.campaigns.map((c) => {
                  const delivered =
                    (c.stats?.sent_email ?? 0) + (c.stats?.sent_in_app ?? 0) + (c.stats?.sent_push ?? 0);
                  const canSend = c.status === "draft" || c.status === "scheduled" || c.status === "failed";
                  return (
                    <TableRow key={c.id}>
                      <TableCell>
                        <div className="font-medium">{c.name}</div>
                        <div className="text-xs text-muted-foreground">{c.subject}</div>
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          {c.channels.map((ch) => {
                            const Icon = CHANNEL_ICON[ch];
                            return <Icon key={ch} className="h-4 w-4 text-muted-foreground" />;
                          })}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge className={STATUS_COLOR[c.status] ?? ""} variant="secondary">
                          {c.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="tabular-nums">{c.status === "sent" ? delivered : "—"}</TableCell>
                      <TableCell className="text-right">
                        {canSend && (
                          <Button
                          aria-label={`Send ${c.name}`}
                            size="sm"
                            className="mr-1"
                            disabled={sendingId === c.id}
                            onClick={async () => {
                              const ok = await confirm({ title: `Send "${c.name}" now?`, confirmLabel: "Send" });
                              if (ok) void doSend(c.id);
                            }}
                          >
                            <Send className="mr-1 h-3.5 w-3.5" /> Send
                          </Button>
                        )}
                        {c.status !== "sending" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive"
                            disabled={del.isPending}
                            onClick={async () => {
                              const ok = await confirm({ title: `Delete "${c.name}"?`, confirmLabel: "Delete", destructive: true });
                              if (ok) del.mutate(c.id);
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {composeOpen && (
        <ComposeDialog open={composeOpen} onOpenChange={setComposeOpen} segments={segData?.segments ?? []} />
      )}

      <MfaStepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => {
          if (pendingSendId) void doSend(pendingSendId);
        }}
      />
    </div>
  );
}
