// US-1852: the operator surface for quests and time-boxed challenges.
//
// What an operator sets here is WHICH quests run, how hard, when, and what they
// pay. What a quest MEANS stays in code — the criteria list is fetched from the
// edge rather than hardcoded, so this form can only ever offer keys the running
// build actually understands.
//
// Two things are deliberately not editable: the quest key (it is the dedupe
// reference a payout was written against, so renaming a live quest would re-pay
// everyone who finished it) and the XP ceiling (the server clamps regardless).

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/ui/page-header";
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
import { edgeFetch } from "@/lib/edge-fetch";
import { Pencil, Plus, Target, Trash2 } from "lucide-react";

type QuestScope = "personal" | "community";
type WindowKind = "weekly" | "monthly" | "fixed";

interface Quest {
  id: string;
  quest_key: string;
  title: string;
  description: string;
  criteria_key: string;
  target: number;
  xp_reward: number;
  scope: QuestScope;
  window_kind: WindowKind;
  starts_at: string | null;
  ends_at: string | null;
  enabled: boolean;
  sort_order: number;
}
interface Criteria {
  key: string;
  label: string;
}
interface QuestsResponse {
  quests: Quest[];
  criteria: Criteria[];
  xpMax: number;
}

const QUERY_KEY = ["growth-quests"];

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

const WINDOW_BLURB: Record<WindowKind, string> = {
  weekly: "Repeats every week, Monday to Monday. Pays once per week.",
  monthly: "Repeats every calendar month. Pays once per month.",
  fixed: "Runs once, between the two dates below.",
};

function EditorDialog({
  open,
  onOpenChange,
  editing,
  criteria,
  xpMax,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  editing: Quest | null;
  criteria: Criteria[];
  xpMax: number;
}) {
  const qc = useQueryClient();
  const [questKey, setQuestKey] = useState(editing?.quest_key ?? "");
  const [title, setTitle] = useState(editing?.title ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [criteriaKey, setCriteriaKey] = useState(editing?.criteria_key ?? criteria[0]?.key ?? "");
  const [target, setTarget] = useState(editing?.target ?? 3);
  const [xpReward, setXpReward] = useState(editing?.xp_reward ?? 25);
  const [scope, setScope] = useState<QuestScope>(editing?.scope ?? "personal");
  const [windowKind, setWindowKind] = useState<WindowKind>(editing?.window_kind ?? "weekly");
  const [startsAt, setStartsAt] = useState(toLocalInput(editing?.starts_at ?? null));
  const [endsAt, setEndsAt] = useState(toLocalInput(editing?.ends_at ?? null));
  const [sortOrder, setSortOrder] = useState(editing?.sort_order ?? 0);

  const needsWindow = windowKind === "fixed";
  const canSave = title.trim().length > 0 &&
    criteriaKey.length > 0 &&
    target > 0 &&
    (!needsWindow || (startsAt !== "" && endsAt !== "")) &&
    (editing !== null || /^[a-z0-9_]{3,64}$/.test(questKey));

  const save = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        title,
        description,
        criteria_key: criteriaKey,
        target,
        xp_reward: xpReward,
        scope,
        window_kind: windowKind,
        starts_at: startsAt ? new Date(startsAt).toISOString() : null,
        ends_at: endsAt ? new Date(endsAt).toISOString() : null,
        sort_order: sortOrder,
      };
      if (!editing) payload.quest_key = questKey;
      const res = await edgeFetch(
        editing ? `/api/admin/growth/quests/${editing.id}` : "/api/admin/growth/quests",
        { method: editing ? "PATCH" : "POST", json: payload },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Save failed");
      return json;
    },
    onSuccess: () => {
      toast.success(editing ? "Quest updated" : "Quest created — switch it on when it is ready");
      qc.invalidateQueries({ queryKey: QUERY_KEY });
      onOpenChange(false);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit quest" : "New quest"}</DialogTitle>
          <DialogDescription>
            Progress is counted from what people already do. A quest adds a goal, not an errand.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!editing && (
            <div className="space-y-2">
              <Label htmlFor="q-key">Quest key</Label>
              <Input
                id="q-key"
                value={questKey}
                placeholder="grade_three_weekly"
                onChange={(e) => setQuestKey(e.target.value.toLowerCase())}
              />
              <p className="text-xs text-muted-foreground">
                Lowercase letters, numbers and underscores. Permanent — payouts are recorded
                against it.
              </p>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="q-title">Title</Label>
            <Input id="q-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="q-desc">Description</Label>
            <Textarea
              id="q-desc"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="q-criteria">What counts</Label>
              <Select value={criteriaKey} onValueChange={setCriteriaKey}>
                <SelectTrigger id="q-criteria" aria-label="What counts"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {criteria.map((c) => (
                    <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="q-scope">Who it is for</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as QuestScope)}>
                <SelectTrigger id="q-scope" aria-label="Who it is for"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="personal">Personal quest</SelectItem>
                  <SelectItem value="community">Community challenge</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-2">
              <Label htmlFor="q-target">How many</Label>
              <Input
                id="q-target"
                type="number"
                min={1}
                value={target}
                onChange={(e) => setTarget(Number(e.target.value))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="q-xp">XP reward</Label>
              <Input
                id="q-xp"
                type="number"
                min={0}
                max={xpMax}
                value={xpReward}
                onChange={(e) => setXpReward(Number(e.target.value))}
              />
              <p className="text-xs text-muted-foreground">Capped at {xpMax}.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="q-sort">Order</Label>
              <Input
                id="q-sort"
                type="number"
                value={sortOrder}
                onChange={(e) => setSortOrder(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="q-window">Window</Label>
            <Select value={windowKind} onValueChange={(v) => setWindowKind(v as WindowKind)}>
              <SelectTrigger id="q-window" aria-label="Window"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="weekly">Every week</SelectItem>
                <SelectItem value="monthly">Every month</SelectItem>
                <SelectItem value="fixed">One fixed run</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{WINDOW_BLURB[windowKind]}</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="q-starts">{needsWindow ? "Starts" : "Starts (optional)"}</Label>
              <Input
                id="q-starts"
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="q-ends">{needsWindow ? "Ends" : "Ends (optional)"}</Label>
              <Input
                id="q-ends"
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!canSave || save.isPending}>
            {save.isPending ? "Saving…" : editing ? "Save changes" : "Create"}
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

  const { data, isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async (): Promise<QuestsResponse> => {
      const res = await edgeFetch("/api/admin/growth/quests");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load quests");
      return json;
    },
  });

  const toggle = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const res = await edgeFetch(`/api/admin/growth/quests/${id}`, {
        method: "PATCH",
        json: { enabled },
      });
      if (!res.ok) {
        throw new Error((await res.json().catch(() => ({}))).error || "Update failed");
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
    onError: (e) => toast.error((e as Error).message),
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const res = await edgeFetch(`/api/admin/growth/quests/${id}`, { method: "DELETE" });
      if (!res.ok) {
        throw new Error((await res.json().catch(() => ({}))).error || "Delete failed");
      }
    },
    onSuccess: () => {
      toast.success("Deleted");
      qc.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const criteriaLabel = (key: string) =>
    data?.criteria.find((c) => c.key === key)?.label ?? key;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Target}
        title="Quests & challenges"
        subtitle="Fresh goals over work people already do. New quests start switched off."
        actions={
          <Button onClick={() => { setEditing(null); setDialogOpen(true); }}>
            <Plus className="mr-1 h-4 w-4" /> New quest
          </Button>
        }
      />

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : !data || data.quests.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-muted-foreground">
            No quests yet.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {data.quests.map((q) => (
            <Card key={q.id}>
              <CardContent className="flex items-start justify-between gap-4 p-4">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{q.title}</span>
                    <Badge variant="secondary">
                      {q.scope === "community" ? "Challenge" : "Personal"}
                    </Badge>
                    <Badge variant="outline">{q.window_kind}</Badge>
                    {!q.enabled && <Badge variant="outline">off</Badge>}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {criteriaLabel(q.criteria_key)} · {q.target} to finish · {q.xp_reward} XP
                  </p>
                  <p className="text-xs text-muted-foreground">
                    <code>{q.quest_key}</code>
                    {q.ends_at ? ` · ends ${new Date(q.ends_at).toLocaleString()}` : ""}
                  </p>
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  <Switch
                    checked={q.enabled}
                    disabled={toggle.isPending}
                    aria-label={q.enabled ? "Switch quest off" : "Switch quest on"}
                    onCheckedChange={(enabled) => toggle.mutate({ id: q.id, enabled })}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setEditing(q); setDialogOpen(true); }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    disabled={del.isPending}
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Delete "${q.title}"?`,
                        description: "XP already paid stays paid — deleting only stops future runs.",
                        confirmLabel: "Delete",
                        destructive: true,
                      });
                      if (ok) del.mutate(q.id);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {dialogOpen && (
        <EditorDialog
          key={editing?.id ?? "new"}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          editing={editing}
          criteria={data?.criteria ?? []}
          xpMax={data?.xpMax ?? 200}
        />
      )}
    </div>
  );
}
