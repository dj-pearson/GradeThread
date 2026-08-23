import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import { Plus, Trash2, Users, X, Pencil } from "lucide-react";

// ── Field metadata — MUST mirror the server allowlist in lib/segments.ts ──
type FieldKind = "enum" | "bool" | "number" | "date" | "date_nullable";
interface FieldMeta {
  label: string;
  kind: FieldKind;
  values?: { value: string; label: string }[];
}
const FIELDS: Record<string, FieldMeta> = {
  flipdesk_plan: {
    label: "FlipDesk plan",
    kind: "enum",
    values: ["free", "starter", "pro", "business"].map((v) => ({ value: v, label: v })),
  },
  subscription_status: {
    label: "Subscription status",
    kind: "enum",
    values: ["none", "trialing", "active", "past_due", "paused", "canceled"].map((v) => ({
      value: v,
      label: v,
    })),
  },
  role: {
    label: "Role",
    kind: "enum",
    values: ["user", "reviewer", "admin", "super_admin"].map((v) => ({ value: v, label: v })),
  },
  suspended: { label: "Suspended", kind: "bool" },
  verified_enabled: { label: "Verified seller", kind: "bool" },
  flipdesk_onboarded: { label: "Completed FlipDesk onboarding", kind: "bool" },
  grades_used_this_month: { label: "Grades used this month", kind: "number" },
  grade_credit_balance: { label: "Grade credit balance", kind: "number" },
  ai_actions_used_this_month: { label: "AI actions this month", kind: "number" },
  created_at: { label: "Signed up", kind: "date" },
  onboarded_at: { label: "Onboarded at", kind: "date_nullable" },
  trial_ends_at: { label: "Trial ends", kind: "date_nullable" },
};

const OPS: Record<string, string> = {
  eq: "is",
  neq: "is not",
  in: "is any of",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  before: "before",
  after: "after",
  within_days: "in last N days",
  is_null: "is empty",
  not_null: "is set",
};
const OPS_BY_KIND: Record<FieldKind, string[]> = {
  enum: ["eq", "neq", "in"],
  bool: ["eq"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte"],
  date: ["before", "after", "within_days"],
  date_nullable: ["before", "after", "within_days", "is_null", "not_null"],
};

interface Condition {
  field: string;
  op: string;
  value: string | number | boolean | string[] | null;
}
interface Rules {
  match: "all" | "any";
  conditions: Condition[];
}
interface Segment {
  id: string;
  name: string;
  description: string | null;
  rules: Rules;
  is_active: boolean;
  created_at: string;
}

const EMPTY_RULES: Rules = { match: "all", conditions: [] };

function defaultValueFor(kind: FieldKind, op: string): Condition["value"] {
  if (op === "is_null" || op === "not_null") return null;
  if (kind === "bool") return true;
  if (kind === "number" || op === "within_days") return 0;
  if (op === "in") return [];
  if (kind === "enum") return "";
  return ""; // dates as ISO/date string
}

// ── Rule builder ──
function RuleBuilder({
  rules,
  onChange,
}: {
  rules: Rules;
  onChange: (r: Rules) => void;
}) {
  const setCondition = (i: number, patch: Partial<Condition>) => {
    const next = rules.conditions.map((c, idx) => (idx === i ? { ...c, ...patch } : c));
    onChange({ ...rules, conditions: next });
  };
  const removeCondition = (i: number) =>
    onChange({ ...rules, conditions: rules.conditions.filter((_, idx) => idx !== i) });
  const addCondition = () => {
    const field = "flipdesk_plan";
    const meta = FIELDS[field]!;
    const op = OPS_BY_KIND[meta.kind][0]!;
    onChange({
      ...rules,
      conditions: [...rules.conditions, { field, op, value: defaultValueFor(meta.kind, op) }],
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm">
        <span>Match</span>
        <Select value={rules.match} onValueChange={(v) => onChange({ ...rules, match: v as "all" | "any" })}>
          {/* US-2335: the visible words are a SENTENCE wrapped around this
              control ("Match [ALL of] these conditions"), so there is no
              label element to associate. Without a name it announces only
              its current value — "ALL of, button". */}
          <SelectTrigger className="w-28" aria-label="Match all or any of these conditions">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">ALL of</SelectItem>
            <SelectItem value="any">ANY of</SelectItem>
          </SelectContent>
        </Select>
        <span>these conditions</span>
      </div>

      {rules.conditions.length === 0 && (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          No conditions — this targets <strong>every user</strong>. Add a condition to narrow it.
        </p>
      )}

      {rules.conditions.map((cond, i) => {
        const meta = FIELDS[cond.field]!;
        const ops = OPS_BY_KIND[meta.kind];
        const showValue = cond.op !== "is_null" && cond.op !== "not_null";
        return (
          <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
            <Select
              value={cond.field}
              onValueChange={(field) => {
                const fieldMeta = FIELDS[field]!;
                const op = OPS_BY_KIND[fieldMeta.kind][0]!;
                setCondition(i, { field, op, value: defaultValueFor(fieldMeta.kind, op) });
              }}
            >
              <SelectTrigger className="w-52" aria-label={`Condition ${i + 1} field`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(FIELDS).map(([k, m]) => (
                  <SelectItem key={k} value={k}>{m.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={cond.op}
              onValueChange={(op) => setCondition(i, { op, value: defaultValueFor(meta.kind, op) })}
            >
              <SelectTrigger className="w-40" aria-label={`Condition ${i + 1} operator`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ops.map((op) => (
                  <SelectItem key={op} value={op}>{OPS[op]}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            {showValue && (
              <ConditionValue
                index={i}
                meta={meta}
                op={cond.op}
                value={cond.value}
                onChange={(value) => setCondition(i, { value })}
              />
            )}

            <Button
              variant="ghost"
              size="icon"
              className="ml-auto"
              onClick={() => removeCondition(i)}
              aria-label={`Remove condition: ${meta.label}`}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        );
      })}

      <Button variant="outline" size="sm" onClick={addCondition}>
        <Plus className="mr-1 h-4 w-4" /> Add condition
      </Button>
    </div>
  );
}

// US-2335: every branch below is the SAME conceptual control — the condition's
// value — rendered as a different widget per field kind. They all carry the
// same name for that reason: someone tabbing a row hears field, operator,
// value, and the name does not change when a different field kind swaps the
// widget underneath it.
function ConditionValue({
  index,
  meta,
  op,
  value,
  onChange,
}: {
  index: number;
  meta: FieldMeta;
  op: string;
  value: Condition["value"];
  onChange: (v: Condition["value"]) => void;
}) {
  if (meta.kind === "bool") {
    return (
      <Select value={String(value)} onValueChange={(v) => onChange(v === "true")}>
        <SelectTrigger className="w-28" aria-label={`Condition ${index + 1} value`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">Yes</SelectItem>
          <SelectItem value="false">No</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  if (meta.kind === "enum" && op !== "in") {
    return (
      <Select value={String(value ?? "")} onValueChange={onChange}>
        <SelectTrigger className="w-44" aria-label={`Condition ${index + 1} value`}>
          <SelectValue placeholder="value" />
        </SelectTrigger>
        <SelectContent>
          {meta.values?.map((v) => (
            <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (op === "in") {
    // Comma-separated list of allowed enum tokens.
    return (
      <Input
        className="w-56"
        aria-label={`Condition ${index + 1} value`}
        placeholder="comma,separated"
        value={Array.isArray(value) ? value.join(",") : ""}
        onChange={(e) =>
          onChange(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))
        }
      />
    );
  }
  if (meta.kind === "number" || op === "within_days") {
    return (
      <Input
        type="number"
        className="w-32"
        aria-label={`Condition ${index + 1} value`}
        value={typeof value === "number" ? value : ""}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    );
  }
  // date before/after
  return (
    <Input
      type="date"
      className="w-44"
      aria-label={`Condition ${index + 1} value`}
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

// ── Segment editor dialog ──
function SegmentDialog({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  editing: Segment | null;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(editing?.name ?? "");
  const [description, setDescription] = useState(editing?.description ?? "");
  const [rules, setRules] = useState<Rules>(editing?.rules ?? EMPTY_RULES);
  const [preview, setPreview] = useState<{ count: number; sampleEmails: string[] } | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const runPreview = async () => {
    setPreviewing(true);
    try {
      const res = await edgeFetch("/api/admin/growth/segments/preview", {
        method: "POST",
        json: { rules },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Preview failed");
      setPreview(json);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPreviewing(false);
    }
  };

  const save = useMutation({
    mutationFn: async () => {
      const path = editing
        ? `/api/admin/growth/segments/${editing.id}`
        : "/api/admin/growth/segments";
      const res = await edgeFetch(path, {
        method: editing ? "PATCH" : "POST",
        json: { name, description, rules },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      return json;
    },
    onSuccess: () => {
      toast.success(editing ? "Segment updated" : "Segment created");
      qc.invalidateQueries({ queryKey: ["growth-segments"] });
      onOpenChange(false);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit segment" : "New segment"}</DialogTitle>
          <DialogDescription>
            Define a reusable audience. Preview the live match count before saving.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="seg-name">Name</Label>
            <Input id="seg-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Active Pro sellers" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="seg-desc">Description</Label>
            <Input id="seg-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="optional" />
          </div>

          <RuleBuilder rules={rules} onChange={(r) => { setRules(r); setPreview(null); }} />

          <div className="flex items-center gap-3 rounded-md bg-muted p-3">
            <Button variant="outline" size="sm" onClick={runPreview} disabled={previewing}>
              <Users className="mr-1 h-4 w-4" /> {previewing ? "Counting…" : "Preview count"}
            </Button>
            {preview && (
              <div className="text-sm">
                <span className="font-semibold tabular-nums">{preview.count.toLocaleString()}</span> users match
                {preview.sampleEmails.length > 0 && (
                  <span className="ml-2 text-muted-foreground">e.g. {preview.sampleEmails.slice(0, 3).join(", ")}</span>
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!name.trim() || save.isPending}>
            {save.isPending ? "Saving…" : editing ? "Save changes" : "Create segment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function GrowthSegmentsPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Segment | null>(null);

  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ["growth-segments"],
    queryFn: async (): Promise<{ segments: Segment[] }> => {
      const res = await edgeFetch("/api/admin/growth/segments");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load segments");
      return json;
    },
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const res = await edgeFetch(`/api/admin/growth/segments/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Delete failed");
    },
    onSuccess: () => {
      toast.success("Segment deleted");
      qc.invalidateQueries({ queryKey: ["growth-segments"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const openNew = () => { setEditing(null); setDialogOpen(true); };
  const openEdit = (s: Segment) => { setEditing(s); setDialogOpen(true); };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audience Segments"
        subtitle="Reusable cohorts for campaigns and announcements."
        actions={
          <Button onClick={openNew}><Plus className="mr-1 h-4 w-4" /> New segment</Button>
        }
      />

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : isError ? (
        /* US-2507: BEFORE the empty branch — a failed load must not read as
           "you have no segments", which invites a duplicate. */
        <Card>
          <CardContent className="p-0">
            <ErrorState
              className="py-10"
              title="Couldn't load segments"
              description="They're still there — we just couldn't fetch them right now."
              onRetry={() => void refetch()}
              retrying={isFetching}
            />
          </CardContent>
        </Card>
      ) : !data || data.segments.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Users}
              title="No segments yet"
              description="Create a segment to target a campaign at a specific group of users."
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {data.segments.map((s) => (
            <Card key={s.id}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-base">
                  {s.name}
                  {!s.is_active && <Badge variant="secondary">inactive</Badge>}
                </CardTitle>
                {s.description && <CardDescription>{s.description}</CardDescription>}
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="text-sm text-muted-foreground">
                  Match <strong>{s.rules.match === "all" ? "ALL" : "ANY"}</strong> of{" "}
                  {s.rules.conditions.length} condition{s.rules.conditions.length === 1 ? "" : "s"}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Edit ${s.name}`}
                    onClick={() => openEdit(s)}
                  >
                    <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
                  </Button>
                  <Button
                  aria-label={`Delete ${s.name}`}
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={async () => {
                      const ok = await confirm({ title: `Delete segment "${s.name}"?`, confirmLabel: "Delete", destructive: true });
                      if (ok) del.mutate(s.id);
                    }}
                  >
                    <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {dialogOpen && (
        <SegmentDialog
          key={editing?.id ?? "new"}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          editing={editing}
        />
      )}
    </div>
  );
}
