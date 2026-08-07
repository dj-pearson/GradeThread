import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Gift, Plus, Trash2 } from "lucide-react";
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

// US-1853: the tangible milestone catalog.
//
// This is the screen where engagement turns into money, so it is built to make
// the cost of a decision visible at the moment it is made:
//
//   • XP is never spent. A milestone is a threshold someone CROSSES, and
//     crossing it grants value — the XP total is untouched, so nobody's level or
//     leaderboard rank drops for taking a reward.
//   • Cost is entered per grant, in what it costs GradeThread to honour (not
//     list price), because the platform budget is denominated in margin.
//   • Every milestone can be switched off on its own, and each carries its own
//     monthly + lifetime issue caps on top of the global USD budget.
//
// Two things the server refuses and the form therefore doesn't offer: renaming
// the key of a milestone that has already been paid (the key is what stops it
// paying twice), and deleting one with grants against it (turn it off instead).

interface Milestone {
  id: string;
  key: string;
  label: string;
  description: string;
  reward_type: "free_grade_credits" | "subscription_discount" | "per_grade_discount";
  trigger_type: "xp_threshold" | "badge" | "season_goal";
  xp_threshold: number | null;
  trigger_key: string | null;
  reward_value: number;
  cost_usd: number;
  discount_duration_months: number | null;
  discount_valid_days: number | null;
  monthly_grant_cap: number | null;
  lifetime_grant_cap: number | null;
  enabled: boolean;
  sort_order: number;
}

interface CatalogOption {
  key: string;
  name: string;
}

interface MilestonesResponse {
  milestones: Milestone[];
  reward_types: Milestone["reward_type"][];
  trigger_types: Milestone["trigger_type"][];
  badges: CatalogOption[];
  season_goals: CatalogOption[];
}

const REWARD_LABELS: Record<Milestone["reward_type"], string> = {
  free_grade_credits: "Free grade credits",
  subscription_discount: "Subscription discount",
  per_grade_discount: "Discounted grading",
};

const TRIGGER_LABELS: Record<Milestone["trigger_type"], string> = {
  xp_threshold: "XP threshold",
  badge: "Badge earned",
  season_goal: "Season goal finished",
};

const usd = (n: number) =>
  n.toLocaleString(undefined, { style: "currency", currency: "USD" });

/** What a milestone gives, in one line. */
function rewardSummary(m: Milestone): string {
  if (m.reward_type === "free_grade_credits") {
    const n = Math.round(m.reward_value);
    return `${n} free grade${n === 1 ? "" : "s"}`;
  }
  if (m.reward_type === "subscription_discount") {
    const months = m.discount_duration_months;
    return `${m.reward_value}% off${months && months > 1 ? ` for ${months} months` : ""}`;
  }
  return `${m.reward_value}% off grading for ${m.discount_valid_days ?? 90} days`;
}

interface Draft {
  key: string;
  label: string;
  description: string;
  reward_type: Milestone["reward_type"];
  trigger_type: Milestone["trigger_type"];
  xp_threshold: string;
  trigger_key: string;
  reward_value: string;
  cost_usd: string;
  discount_duration_months: string;
  discount_valid_days: string;
  monthly_grant_cap: string;
  lifetime_grant_cap: string;
  sort_order: number;
}

const BLANK: Draft = {
  key: "",
  label: "",
  description: "",
  reward_type: "free_grade_credits",
  trigger_type: "xp_threshold",
  xp_threshold: "900",
  trigger_key: "",
  reward_value: "1",
  cost_usd: "0.35",
  discount_duration_months: "",
  discount_valid_days: "",
  monthly_grant_cap: "",
  lifetime_grant_cap: "",
  sort_order: 100,
};

const num = (v: number | null) => (v === null ? "" : String(v));

function toDraft(m: Milestone): Draft {
  return {
    key: m.key,
    label: m.label,
    description: m.description,
    reward_type: m.reward_type,
    trigger_type: m.trigger_type,
    xp_threshold: num(m.xp_threshold),
    trigger_key: m.trigger_key ?? "",
    reward_value: String(m.reward_value),
    cost_usd: String(m.cost_usd),
    discount_duration_months: num(m.discount_duration_months),
    discount_valid_days: num(m.discount_valid_days),
    monthly_grant_cap: num(m.monthly_grant_cap),
    lifetime_grant_cap: num(m.lifetime_grant_cap),
    sort_order: m.sort_order,
  };
}

/** "" → null so a blank box means "no cap" rather than zero. */
const orNull = (v: string) => (v.trim() === "" ? null : Number(v));

function MilestoneDialog({
  open,
  onOpenChange,
  editing,
  options,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  editing: Milestone | null;
  options: Pick<MilestonesResponse, "badges" | "season_goals">;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>(editing ? toDraft(editing) : BLANK);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const isCredits = draft.reward_type === "free_grade_credits";
  const isSubDiscount = draft.reward_type === "subscription_discount";
  const isXpTrigger = draft.trigger_type === "xp_threshold";
  const triggerOptions = draft.trigger_type === "badge" ? options.badges : options.season_goals;

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        key: draft.key,
        label: draft.label,
        description: draft.description,
        reward_type: draft.reward_type,
        trigger_type: draft.trigger_type,
        xp_threshold: isXpTrigger ? Number(draft.xp_threshold) : null,
        trigger_key: isXpTrigger ? null : draft.trigger_key,
        reward_value: Number(draft.reward_value),
        cost_usd: Number(draft.cost_usd),
        discount_duration_months: isSubDiscount ? orNull(draft.discount_duration_months) : null,
        discount_valid_days: !isCredits && !isSubDiscount
          ? orNull(draft.discount_valid_days)
          : null,
        monthly_grant_cap: orNull(draft.monthly_grant_cap),
        lifetime_grant_cap: orNull(draft.lifetime_grant_cap),
        sort_order: draft.sort_order,
      };
      const res = await edgeFetch(
        editing
          ? `/api/admin/rewards/milestones/${editing.id}`
          : "/api/admin/rewards/milestones",
        { method: editing ? "PATCH" : "POST", json: body },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Save failed");
      return json;
    },
    onSuccess: () => {
      toast.success(editing ? "Milestone updated" : "Milestone created");
      qc.invalidateQueries({ queryKey: ["admin-reward-milestones"] });
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit milestone" : "New milestone"}</DialogTitle>
          <DialogDescription>
            What unlocks it, what it gives, and what it costs us. New milestones start
            switched off.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="ms-key">Key</Label>
              <Input
                id="ms-key"
                value={draft.key}
                onChange={(e) => set("key", e.target.value)}
                placeholder="xp_900_credits_1"
              />
              {editing && (
                <p className="text-xs text-muted-foreground">
                  Fixed once anyone has been paid this reward.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ms-label">Label</Label>
              <Input
                id="ms-label"
                value={draft.label}
                onChange={(e) => set("label", e.target.value)}
                placeholder="1 free grade"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ms-desc">Description</Label>
            <Textarea
              id="ms-desc"
              value={draft.description}
              onChange={(e) => set("description", e.target.value)}
              rows={2}
              placeholder="Reach 900 XP."
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Unlocked by</Label>
              <Select
                value={draft.trigger_type}
                onValueChange={(v) => set("trigger_type", v as Draft["trigger_type"])}
              >
                <SelectTrigger aria-label="What unlocks the milestone">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="xp_threshold">XP threshold</SelectItem>
                  <SelectItem value="badge">Badge earned</SelectItem>
                  <SelectItem value="season_goal">Season goal finished</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {isXpTrigger
              ? (
                <div className="space-y-1.5">
                  <Label htmlFor="ms-xp">XP threshold</Label>
                  <Input
                    id="ms-xp"
                    type="number"
                    min={0}
                    value={draft.xp_threshold}
                    onChange={(e) => set("xp_threshold", e.target.value)}
                  />
                </div>
              )
              : (
                <div className="space-y-1.5">
                  <Label>{draft.trigger_type === "badge" ? "Badge" : "Season goal"}</Label>
                  <Select
                    value={draft.trigger_key}
                    onValueChange={(v) => set("trigger_key", v)}
                  >
                    <SelectTrigger aria-label="Which badge or season goal">
                      <SelectValue placeholder="Choose one" />
                    </SelectTrigger>
                    <SelectContent>
                      {triggerOptions.map((o) => (
                        <SelectItem key={o.key} value={o.key}>{o.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Reward</Label>
              <Select
                value={draft.reward_type}
                onValueChange={(v) => set("reward_type", v as Draft["reward_type"])}
              >
                <SelectTrigger aria-label="Reward type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="free_grade_credits">Free grade credits</SelectItem>
                  <SelectItem value="subscription_discount">Subscription discount</SelectItem>
                  <SelectItem value="per_grade_discount">Discounted grading</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ms-value">{isCredits ? "Credits" : "Percent off"}</Label>
              <Input
                id="ms-value"
                type="number"
                min={1}
                max={isCredits ? undefined : 100}
                value={draft.reward_value}
                onChange={(e) => set("reward_value", e.target.value)}
              />
            </div>
          </div>

          {!isCredits && (
            <div className="space-y-1.5">
              <Label htmlFor="ms-window">
                {isSubDiscount ? "Repeats for (months)" : "Stays live for (days)"}
              </Label>
              <Input
                id="ms-window"
                type="number"
                min={1}
                max={isSubDiscount ? 12 : 730}
                value={isSubDiscount ? draft.discount_duration_months : draft.discount_valid_days}
                onChange={(e) =>
                  set(
                    isSubDiscount ? "discount_duration_months" : "discount_valid_days",
                    e.target.value,
                  )}
                placeholder={isSubDiscount ? "1 invoice" : "90"}
              />
              <p className="text-xs text-muted-foreground">
                {isSubDiscount
                  ? "Blank means a single invoice. Redeemed at their next subscription checkout."
                  : "Blank means 90 days. After that it simply stops applying."}
              </p>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="ms-cost">Cost to us (USD)</Label>
              <Input
                id="ms-cost"
                type="number"
                min={0}
                step="0.01"
                value={draft.cost_usd}
                onChange={(e) => set("cost_usd", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ms-cap-month">Monthly cap</Label>
              <Input
                id="ms-cap-month"
                type="number"
                min={1}
                value={draft.monthly_grant_cap}
                onChange={(e) => set("monthly_grant_cap", e.target.value)}
                placeholder="No cap"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ms-cap-life">Lifetime cap</Label>
              <Input
                id="ms-cap-life"
                type="number"
                min={1}
                value={draft.lifetime_grant_cap}
                onChange={(e) => set("lifetime_grant_cap", e.target.value)}
                placeholder="No cap"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Cost is what honouring one grant costs GradeThread, not its list price — the
            platform reward budget is measured in margin. Caps count grants of this
            milestone across everyone; each person can only ever receive it once.
          </p>

          <div className="space-y-1.5 sm:w-32">
            <Label htmlFor="ms-sort">Sort</Label>
            <Input
              id="ms-sort"
              type="number"
              value={draft.sort_order}
              onChange={(e) => set("sort_order", Number(e.target.value))}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Saving…" : editing ? "Save changes" : "Create milestone"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function GrowthRewardMilestonesPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Milestone | null>(null);

  const { data, isLoading } = useQuery<MilestonesResponse>({
    queryKey: ["admin-reward-milestones"],
    queryFn: async () => {
      const res = await edgeFetch("/api/admin/rewards/milestones");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Couldn't load the milestones.");
      return json as MilestonesResponse;
    },
  });

  const toggle = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const res = await edgeFetch(`/api/admin/rewards/milestones/${id}`, {
        method: "PATCH",
        json: { enabled },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Update failed");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-reward-milestones"] }),
    onError: (err: Error) => toast.error(err.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await edgeFetch(`/api/admin/rewards/milestones/${id}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Delete failed");
    },
    onSuccess: () => {
      toast.success("Milestone deleted");
      qc.invalidateQueries({ queryKey: ["admin-reward-milestones"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const milestones = data?.milestones ?? [];
  const options = { badges: data?.badges ?? [], season_goals: data?.season_goals ?? [] };

  const openNew = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (m: Milestone) => {
    setEditing(m);
    setDialogOpen(true);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Milestone rewards"
        subtitle="Crossing a milestone grants real value. XP is never spent, so nobody's level or rank drops for taking a reward."
        icon={Gift}
        actions={
          <Button onClick={openNew}>
            <Plus className="mr-2 h-4 w-4" />
            New milestone
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
            : milestones.length === 0
            ? (
              <EmptyState
                icon={Gift}
                title="No milestones yet"
                description="Create one to turn a threshold into something a seller can actually use."
              />
            )
            : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Milestone</TableHead>
                    <TableHead>Unlocked by</TableHead>
                    <TableHead>Gives</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="text-right">Caps</TableHead>
                    <TableHead className="text-right">Live</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {milestones.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>
                        <button
                          type="button"
                          onClick={() => openEdit(m)}
                          className="text-left font-medium hover:underline"
                        >
                          {m.label}
                        </button>
                        <p className="text-xs text-muted-foreground">{m.key}</p>
                        <Badge variant="secondary" className="mt-1 text-xs">
                          {REWARD_LABELS[m.reward_type]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {m.trigger_type === "xp_threshold"
                          ? `${(m.xp_threshold ?? 0).toLocaleString()} XP`
                          : `${TRIGGER_LABELS[m.trigger_type]}: ${m.trigger_key}`}
                      </TableCell>
                      <TableCell className="text-sm">{rewardSummary(m)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {usd(m.cost_usd)}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {m.monthly_grant_cap ?? "—"} / {m.lifetime_grant_cap ?? "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Switch
                          checked={m.enabled}
                          onCheckedChange={(enabled) => toggle.mutate({ id: m.id, enabled })}
                          aria-label={`${m.enabled ? "Disable" : "Enable"} ${m.label}`}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Delete ${m.label}`}
                          onClick={async () => {
                            const ok = await confirm({
                              title: "Delete this milestone?",
                              description:
                                "Only a milestone nobody has been paid can be deleted. Otherwise switch it off instead.",
                              confirmLabel: "Delete milestone",
                              destructive: true,
                            });
                            if (ok) remove.mutate(m.id);
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
        <MilestoneDialog
          key={editing?.id ?? "new"}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          editing={editing}
          options={options}
        />
      )}
    </div>
  );
}
