import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import { edgeFetch } from "@/lib/edge-fetch";
import {
  AlertTriangle,
  Database,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";

interface ConditionIndexSeed {
  id: string;
  slug: string;
  label: string;
  brand: string;
  category_id: string;
  q: string | null;
  enabled: boolean;
  priority: number;
  // US-1746: 'curated' or 'generated' (proposed by the seed-gen cron).
  source: string | null;
  generated_at: string | null;
  created_at: string;
  updated_at: string;
  sample_depth: number | null;
  refreshed_at: string | null;
  below_threshold: boolean;
}

interface SeedsResponse {
  seeds: ConditionIndexSeed[];
  publishThreshold: number;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "Never";
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

// Create/edit dialog. `seed === null` while open means "create".
function SeedDialog({
  open,
  seed,
  onOpenChange,
  onSubmit,
  pending,
}: {
  open: boolean;
  seed: ConditionIndexSeed | null;
  onOpenChange: (o: boolean) => void;
  onSubmit: (id: string | null, payload: Record<string, unknown>) => void;
  pending: boolean;
}) {
  const [slug, setSlug] = useState("");
  const [label, setLabel] = useState("");
  const [brand, setBrand] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [q, setQ] = useState("");
  const [priority, setPriority] = useState("100");
  const [enabled, setEnabled] = useState(true);
  const [seededFor, setSeededFor] = useState<string | null>(null);

  // Re-seed the form whenever a different row (or "new") is opened.
  const formKey = seed?.id ?? (open ? "__new__" : null);
  if (open && seededFor !== formKey) {
    setSlug(seed?.slug ?? "");
    setLabel(seed?.label ?? "");
    setBrand(seed?.brand ?? "");
    setCategoryId(seed?.category_id ?? "");
    setQ(seed?.q ?? "");
    setPriority(String(seed?.priority ?? 100));
    setEnabled(seed?.enabled ?? true);
    setSeededFor(formKey);
  }

  const submit = () => {
    const payload: Record<string, unknown> = {
      slug: slug.trim(),
      label: label.trim(),
      brand: brand.trim(),
      category_id: categoryId.trim(),
      q: q.trim() || null,
      priority: Math.trunc(Number(priority)) || 0,
      enabled,
    };
    onSubmit(seed?.id ?? null, payload);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{seed ? "Edit Index entry" : "New Index entry"}</DialogTitle>
          <DialogDescription>
            A curated Condition Index entry. The comps engine queries eBay by{" "}
            <span className="font-mono">brand · category · keyword</span>; the slug
            is the public URL (<span className="font-mono">/condition-index/&lt;slug&gt;</span>).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="ci-slug">Slug</Label>
            <Input id="ci-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="patagonia-better-sweater"
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Lowercase letters, numbers and hyphens only. Changing it changes the
              public URL.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ci-label">Label</Label>
            <Input id="ci-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Patagonia Better Sweater"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="ci-brand">Brand</Label>
              <Input id="ci-brand" value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="Patagonia" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ci-ebay-category-id">eBay category ID</Label>
              <Input id="ci-ebay-category-id"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                placeholder="11450"
                className="font-mono text-sm"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="ci-keyword-optional">Keyword (optional)</Label>
              <Input id="ci-keyword-optional" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Better Sweater" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ci-priority">Priority</Label>
              <Input id="ci-priority" type="number" value={priority} onChange={(e) => setPriority(e.target.value)} />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <div>
              <span className="text-sm font-medium">Enabled</span>
              <p className="text-xs text-muted-foreground">
                Disabled entries are skipped by the refresh job and never published.
              </p>
            </div>
            <Switch aria-label="Enabled" checked={enabled} onCheckedChange={setEnabled} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={pending}>
            {pending ? "Saving…" : seed ? "Save entry" : "Create entry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AdminConditionIndexPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editSeed, setEditSeed] = useState<ConditionIndexSeed | null>(null);
  const [working, setWorking] = useState(false);
  // Per-row refresh spinner.
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-condition-index"],
    queryFn: async (): Promise<SeedsResponse> => {
      const res = await edgeFetch("/api/admin/condition-index");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load Condition Index.");
      return json;
    },
    staleTime: 30_000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["admin-condition-index"] });

  const saveSeed = async (id: string | null, payload: Record<string, unknown>) => {
    setWorking(true);
    try {
      const res = await edgeFetch(
        id ? `/api/admin/condition-index/${id}` : "/api/admin/condition-index",
        { method: id ? "PUT" : "POST", json: payload, silentGate: true },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error((json as { error?: string }).error ?? "Save failed");
        return;
      }
      toast.success(id ? "Entry updated" : "Entry created");
      setDialogOpen(false);
      setEditSeed(null);
      invalidate();
    } finally {
      setWorking(false);
    }
  };

  const toggleEnabled = async (seed: ConditionIndexSeed) => {
    setWorking(true);
    try {
      const res = await edgeFetch(`/api/admin/condition-index/${seed.id}`, {
        method: "PUT",
        json: { enabled: !seed.enabled },
        silentGate: true,
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        toast.error((json as { error?: string }).error ?? "Update failed");
        return;
      }
      toast.success(seed.enabled ? "Entry disabled" : "Entry enabled");
      invalidate();
    } finally {
      setWorking(false);
    }
  };

  const deleteSeed = async (seed: ConditionIndexSeed) => {
    const ok = await confirm({
      title: `Delete "${seed.label}"?`,
      description: "This removes it from the catalog.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setWorking(true);
    try {
      const res = await edgeFetch(`/api/admin/condition-index/${seed.id}`, {
        method: "DELETE",
        silentGate: true,
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        toast.error((json as { error?: string }).error ?? "Delete failed");
        return;
      }
      toast.success("Entry deleted");
      invalidate();
    } finally {
      setWorking(false);
    }
  };

  const refreshOne = async (seed: ConditionIndexSeed) => {
    setRefreshingId(seed.id);
    try {
      const res = await edgeFetch(`/api/admin/condition-index/${seed.id}/refresh`, {
        method: "POST",
        json: {},
        silentGate: true,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error((json as { error?: string }).error ?? "Refresh failed");
        return;
      }
      toast.success(`Refreshed — ${(json as { sample_depth?: number }).sample_depth ?? 0} comps`);
      invalidate();
    } finally {
      setRefreshingId(null);
    }
  };

  const refreshAll = async () => {
    setRefreshingAll(true);
    try {
      const res = await edgeFetch("/api/admin/condition-index/refresh", {
        method: "POST",
        json: {},
        silentGate: true,
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 409) {
        toast.error("A refresh is already running — try again shortly.");
        return;
      }
      if (!res.ok) {
        toast.error((json as { error?: string }).error ?? "Refresh failed");
        return;
      }
      const { refreshed = 0, failed = 0 } = json as { refreshed?: number; failed?: number };
      toast.success(`Catalog refreshed — ${refreshed} updated${failed ? `, ${failed} failed` : ""}`);
      invalidate();
    } finally {
      setRefreshingAll(false);
    }
  };

  const threshold = data?.publishThreshold ?? 8;
  const seeds = data?.seeds ?? [];
  const flagged = seeds.filter((s) => s.below_threshold && s.enabled).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Condition Index"
        subtitle={
          <>
            Curate the public Condition Index catalog. Each entry is refreshed from
            live eBay comps; entries below {threshold} total comps never publish
            (US-622).
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              onClick={refreshAll}
              disabled={refreshingAll || working}
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${refreshingAll ? "animate-spin" : ""}`} />
              {refreshingAll ? "Refreshing…" : "Refresh all"}
            </Button>
            <Button
              onClick={() => {
                setEditSeed(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              New entry
            </Button>
          </>
        }
      />

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          <AlertTriangle className="h-4 w-4" />
          {(error as Error).message}
        </div>
      )}

      {flagged > 0 && (
        <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4" />
          {flagged} enabled {flagged === 1 ? "entry is" : "entries are"} below the
          publish threshold — consider refreshing, broadening the query, or pruning.
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-5 w-5" />
            Catalog entries
          </CardTitle>
          <CardDescription>
            Sample depth is the total comp support behind each curve. Rows under{" "}
            {threshold} comps are flagged — they're suppressed on the public Index.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6">
              <Skeleton className="h-40 w-full" />
            </div>
          ) : seeds.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No Condition Index entries yet.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Entry</TableHead>
                  <TableHead>Query</TableHead>
                  <TableHead className="text-right">Sample depth</TableHead>
                  <TableHead>Refreshed</TableHead>
                  <TableHead className="text-center">Priority</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {seeds.map((s) => (
                  <TableRow key={s.id} className={s.enabled ? "" : "opacity-60"}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{s.label}</span>
                        {s.source === "generated" && (
                          <Badge variant="secondary" className="text-xs">Auto</Badge>
                        )}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">{s.slug}</div>
                    </TableCell>
                    <TableCell className="text-sm">
                      <div>{s.brand}</div>
                      <div className="text-xs text-muted-foreground">
                        cat {s.category_id}
                        {s.q ? ` · "${s.q}"` : ""}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s.sample_depth == null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className={s.below_threshold ? "font-semibold text-amber-600 dark:text-amber-400" : ""}>
                          {s.sample_depth}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {relativeTime(s.refreshed_at)}
                    </TableCell>
                    <TableCell className="text-center tabular-nums">{s.priority}</TableCell>
                    <TableCell>
                      {!s.enabled ? (
                        <Badge variant="secondary">Disabled</Badge>
                      ) : s.below_threshold ? (
                        <Badge variant="outline" className="border-amber-400 text-amber-600 dark:text-amber-400">
                          Below threshold
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-emerald-400 text-emerald-600 dark:text-emerald-400">
                          Published
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={refreshingId === s.id || refreshingAll}
                          onClick={() => refreshOne(s)}
                          aria-label={`Refresh comps for ${s.label}`}
                          title="Refresh comps now"
                        >
                          <RefreshCw className={`h-3.5 w-3.5 ${refreshingId === s.id ? "animate-spin" : ""}`} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={working}
                          onClick={() => {
                            setEditSeed(s);
                            setDialogOpen(true);
                          }}
                          aria-label={`Edit ${s.label}`}
                          title="Edit entry"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Switch
                          checked={s.enabled}
                          disabled={working}
                          onCheckedChange={() => toggleEnabled(s)}
                          aria-label={`${s.enabled ? "Disable" : "Enable"} ${s.label}`}
                          title={s.enabled ? "Disable" : "Enable"}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={working}
                          onClick={() => deleteSeed(s)}
                          aria-label={`Delete ${s.label}`}
                          title="Delete entry"
                        >
                          <Trash2 className="h-3.5 w-3.5 text-red-500" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <SeedDialog
        open={dialogOpen}
        seed={editSeed}
        onOpenChange={(o) => {
          setDialogOpen(o);
          if (!o) setEditSeed(null);
        }}
        onSubmit={saveSeed}
        pending={working}
      />
    </div>
  );
}
