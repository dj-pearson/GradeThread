import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, Target, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ui/confirm-dialog";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { edgeFetch } from "@/lib/edge-fetch";

// US-1852: quest + community-challenge administration.
//
// The three things an operator has to be able to change without a deploy are the
// CRITERIA (metric + target), the WINDOW (cadence, or explicit start/end) and the
// REWARD (XP) — plus a per-quest kill-switch, which is the `enabled` toggle in
// the table rather than a hidden setting.
//
// Deleting is deliberately restricted server-side: a quest people have already
// completed cannot be deleted, because that would erase their completions while
// the ledger rows that paid them survive. Turning it off is the retire path.

interface Quest {
  id: string;
  key: string;
  name: string;
  description: string;
  quest_type: "personal" | "community";
  metric: string;
  target: number;
  cadence: "weekly" | "monthly" | "fixed";
  starts_at: string | null;
  ends_at: string | null;
  xp_reward: number;
  icon: string;
  enabled: boolean;
  sort_order: number;
}

interface QuestsResponse {
  quests: Quest[];
  metrics: string[];
  xp_max: number;
}

const METRIC_LABELS: Record<string, string> = {
  coverage_completed: "Graded with full photos",
  badge_embedded: "Badge embedded off-platform",
  aspects_filled: "Item specifics filled",
  marketplace_connected: "Marketplace connected",
  verified_share: "Verified share",
  verified_purchase: "Verified purchase",
  grade_confirmed: "Grade confirmed",
  xp: "Raw XP",
};

interface Draft {
  key: string;
  name: string;
  description: string;
  quest_type: Quest["quest_type"];
  metric: string;
  target: number;
  cadence: Quest["cadence"];
  /** `datetime-local` value (local wall clock), converted to ISO on save. */
  starts_at: string;
  ends_at: string;
  xp_reward: number;
  icon: string;
  sort_order: number;
}

const BLANK: Draft = {
  key: "",
  name: "",
  description: "",
  quest_type: "personal",
  metric: "coverage_completed",
  target: 3,
  cadence: "weekly",
  starts_at: "",
  ends_at: "",
  xp_reward: 20,
  icon: "Target",
  sort_order: 100,
};

function toDraft(quest: Quest): Draft {
  return {
    key: quest.key,
    name: quest.name,
    description: quest.description,
    quest_type: quest.quest_type,
    metric: quest.metric,
    target: quest.target,
    cadence: quest.cadence,
    starts_at: quest.starts_at ? quest.starts_at.slice(0, 16) : "",
    ends_at: quest.ends_at ? quest.ends_at.slice(0, 16) : "",
    xp_reward: quest.xp_reward,
    icon: quest.icon,
    sort_order: quest.sort_order,
  };
}

function QuestDialog({
  open,
  onOpenChange,
  editing,
  metrics,
  xpMax,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  editing: Quest | null;
  metrics: string[];
  xpMax: number;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>(editing ? toDraft(editing) : BLANK);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  // A community challenge is time-boxed by definition, so the form pins it to a
  // fixed window rather than letting an operator build one the server rejects.
  const isCommunity = draft.quest_type === "community";
  const cadence = isCommunity ? "fixed" : draft.cadence;
  const needsWindow = cadence === "fixed";

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        ...draft,
        cadence,
        starts_at: needsWindow && draft.starts_at
          ? new Date(draft.starts_at).toISOString()
          : null,
        ends_at: needsWindow && draft.ends_at ? new Date(draft.ends_at).toISOString() : null,
      };
      const res = await edgeFetch(
        editing ? `/api/admin/rewards/quests/${editing.id}` : "/api/admin/rewards/quests",
        { method: editing ? "PATCH" : "POST", json: body },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Save failed");
      return json;
    },
    onSuccess: () => {
      toast.success(editing ? "Quest updated" : "Quest created");
      qc.invalidateQueries({ queryKey: ["admin-reward-quests"] });
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit quest" : "New quest"}</DialogTitle>
          <DialogDescription>
            Criteria, window and reward. Rewards are capped at {xpMax} XP.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="quest-key">Key</Label>
              <Input
                id="quest-key"
                value={draft.key}
                onChange={(e) => set("key", e.target.value)}
                placeholder="week_grade_3"
                disabled={!!editing}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="quest-name">Name</Label>
              <Input
                id="quest-name"
                value={draft.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="Grade three items"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="quest-desc">Description</Label>
            <Textarea
              id="quest-desc"
              value={draft.description}
              onChange={(e) => set("description", e.target.value)}
              rows={2}
              placeholder="Grade 3 items with full photo coverage this week."
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select
                value={draft.quest_type}
                onValueChange={(v) => set("quest_type", v as Draft["quest_type"])}
              >
                <SelectTrigger aria-label="Quest type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="personal">Personal</SelectItem>
                  <SelectItem value="community">Community challenge</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Window</Label>
              <Select
                value={cadence}
                onValueChange={(v) => set("cadence", v as Draft["cadence"])}
                disabled={isCommunity}
              >
                <SelectTrigger aria-label="Quest window"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="weekly">Repeats weekly</SelectItem>
                  <SelectItem value="monthly">Repeats monthly</SelectItem>
                  <SelectItem value="fixed">Fixed dates</SelectItem>
                </SelectContent>
              </Select>
              {isCommunity && (
                <p className="text-xs text-muted-foreground">
                  A community challenge has to end so its standings can be final.
                </p>
              )}
            </div>
          </div>

          {needsWindow && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="quest-start">Starts</Label>
                <Input
                  id="quest-start"
                  type="datetime-local"
                  value={draft.starts_at}
                  onChange={(e) => set("starts_at", e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="quest-end">Ends</Label>
                <Input
                  id="quest-end"
                  type="datetime-local"
                  value={draft.ends_at}
                  onChange={(e) => set("ends_at", e.target.value)}
                />
              </div>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5 sm:col-span-2">
              <Label>Counts</Label>
              <Select value={draft.metric} onValueChange={(v) => set("metric", v)}>
                <SelectTrigger aria-label="What the quest counts"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {metrics
                    .filter((m) => !(isCommunity && m === "xp"))
                    .map((m) => (
                      <SelectItem key={m} value={m}>{METRIC_LABELS[m] ?? m}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="quest-target">Target</Label>
              <Input
                id="quest-target"
                type="number"
                min={1}
                value={draft.target}
                onChange={(e) => set("target", Number(e.target.value))}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="quest-xp">XP reward</Label>
              <Input
                id="quest-xp"
                type="number"
                min={0}
                max={xpMax}
                value={draft.xp_reward}
                onChange={(e) => set("xp_reward", Number(e.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="quest-icon">Icon</Label>
              <Input
                id="quest-icon"
                value={draft.icon}
                onChange={(e) => set("icon", e.target.value)}
                placeholder="Camera"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="quest-sort">Sort</Label>
              <Input
                id="quest-sort"
                type="number"
                value={draft.sort_order}
                onChange={(e) => set("sort_order", Number(e.target.value))}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Saving…" : editing ? "Save changes" : "Create quest"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function GrowthQuestsPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Quest | null>(null);

  const { data, isLoading } = useQuery<QuestsResponse>({
    queryKey: ["admin-reward-quests"],
    queryFn: async () => {
      const res = await edgeFetch("/api/admin/rewards/quests");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't load the quests.");
      return json as QuestsResponse;
    },
  });

  const toggle = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const res = await edgeFetch(`/api/admin/rewards/quests/${id}`, {
        method: "PATCH",
        json: { enabled },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Update failed");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-reward-quests"] }),
    onError: (err: Error) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await edgeFetch(`/api/admin/rewards/quests/${id}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Delete failed");
    },
    onSuccess: () => {
      toast.success("Quest deleted");
      qc.invalidateQueries({ queryKey: ["admin-reward-quests"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const quests = data?.quests ?? [];

  const openNew = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (quest: Quest) => {
    setEditing(quest);
    setDialogOpen(true);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Quests & challenges"
        subtitle="Short personal goals and time-boxed community challenges. Each one can be switched off on its own."
        icon={Target}
        actions={
          <Button onClick={openNew}>
            <Plus className="mr-2 h-4 w-4" />
            New quest
          </Button>
        }
      />

      <Card>
        <CardContent className="p-0">
          {isLoading
            ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            )
            : quests.length === 0
            ? (
              <EmptyState
                icon={Target}
                title="No quests yet"
                description="Create one to give sellers a reason to come back this week."
              />
            )
            : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Quest</TableHead>
                    <TableHead>Counts</TableHead>
                    <TableHead>Window</TableHead>
                    <TableHead className="text-right">XP</TableHead>
                    <TableHead className="text-right">Live</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {quests.map((q) => (
                    <TableRow key={q.id}>
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => openEdit(q)}
                          className="text-left font-medium hover:underline"
                        >
                          {q.name}
                        </button>
                        <p className="text-xs text-muted-foreground">{q.key}</p>
                        {q.quest_type === "community" && (
                          <Badge variant="secondary" className="mt-1 text-xs">Community</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {q.target} × {METRIC_LABELS[q.metric] ?? q.metric}
                      </TableCell>
                      <TableCell className="text-sm">
                        {q.cadence === "fixed"
                          ? `${q.starts_at?.slice(0, 10) ?? "?"} → ${q.ends_at?.slice(0, 10) ?? "?"}`
                          : q.cadence}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{q.xp_reward}</TableCell>
                      <TableCell className="text-right">
                        <Switch
                          checked={q.enabled}
                          onCheckedChange={(enabled) => toggle.mutate({ id: q.id, enabled })}
                          aria-label={`${q.enabled ? "Disable" : "Enable"} ${q.name}`}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${q.name}`}
                          onClick={async () => {
                            const ok = await confirm({
                              title: "Delete this quest?",
                              description:
                                "Only a quest nobody has completed can be deleted. Otherwise switch it off instead.",
                              confirmLabel: "Delete quest",
                              destructive: true,
                            });
                            if (ok) remove.mutate(q.id);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
        </CardContent>
      </Card>

      {dialogOpen && (
        <QuestDialog
          key={editing?.id ?? "new"}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          editing={editing}
          metrics={data?.metrics ?? []}
          xpMax={data?.xp_max ?? 200}
        />
      )}
    </div>
  );
}
