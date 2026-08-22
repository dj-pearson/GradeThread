import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MapPin, Plus, Pencil, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadingRegion, TableLoadingSkeleton } from "@/components/ui/skeletons";
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
import { ClickableRow } from "@/components/clickable-row";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { useWorkspace } from "@/hooks/use-workspace";
import { useSources } from "@/hooks/use-sources";
import {
  FLIPDESK_SOURCE_TYPES,
  FLIPDESK_SOURCE_TYPE_LABELS,
} from "@/lib/constants";
import type { FlipdeskSourceType, SourceRow } from "@/types/database";

interface FormState {
  id: string | null;
  name: string;
  source_type: FlipdeskSourceType;
  location: string;
  notes: string;
}

const EMPTY: FormState = {
  id: null,
  name: "",
  source_type: "other",
  location: "",
  notes: "",
};

export function FlipdeskSourcesPage() {
  const user = useAuthStore((s) => s.user);
  const { workspaceOwnerId, can } = useWorkspace();
  const qc = useQueryClient();
  const { data: sources = [], isLoading, error } = useSources();
  const [editing, setEditing] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<SourceRow | null>(null);

  // Item counts per source — small extra query, grouped client-side.
  const { data: itemRows } = useQuery({
    queryKey: ["inventory_items_source_counts", user?.id],
    enabled: !!user,
    queryFn: async (): Promise<Array<{ source_id: string | null }>> => {
      const { data, error: qErr } = await supabase
        .from("inventory_items")
        .select("source_id");
      if (qErr) throw qErr;
      return (data ?? []) as Array<{ source_id: string | null }>;
    },
  });

  const itemCountBySource = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of itemRows ?? []) {
      if (!r.source_id) continue;
      counts.set(r.source_id, (counts.get(r.source_id) ?? 0) + 1);
    }
    return counts;
  }, [itemRows]);

  async function save() {
    if (!user || !workspaceOwnerId || !editing) return;
    if (!can("manage_inventory")) {
      toast.error("You don't have permission to manage sources in this workspace.");
      return;
    }
    const name = editing.name.trim();
    if (!name) {
      toast.error("Name is required.");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        user_id: workspaceOwnerId,
        name,
        source_type: editing.source_type,
        location: editing.location.trim() || null,
        notes: editing.notes.trim() || null,
      };
      if (editing.id) {
        const { error: uErr } = await supabase
          .from("sources")
          .update(payload as never)
          .eq("id", editing.id);
        if (uErr) throw uErr;
      } else {
        const { error: iErr } = await supabase
          .from("sources")
          .insert(payload as never);
        if (iErr) throw iErr;
      }
      await qc.invalidateQueries({ queryKey: ["sources"] });
      toast.success(editing.id ? "Source updated." : "Source created.");
      setEditing(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Save failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  async function performDelete() {
    if (!confirmDelete) return;
    const target = confirmDelete;
    setConfirmDelete(null);
    try {
      const { error: dErr } = await supabase
        .from("sources")
        .delete()
        .eq("id", target.id);
      if (dErr) throw dErr;
      await qc.invalidateQueries({ queryKey: ["sources"] });
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      // US-1636: the per-source item-count widget on this page keys off its own
      // query — refresh it too so the deleted source's row/count disappears
      // instead of lingering until stale.
      await qc.invalidateQueries({ queryKey: ["inventory_items_source_counts"] });
      toast.success(`Deleted "${target.name}".`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Delete failed: ${msg}`);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={MapPin}
        title="Sources"
        subtitle="Where your inventory comes from. Linked to every item."
        actions={
          <Button onClick={() => setEditing({ ...EMPTY })}>
            <Plus className="mr-2 h-4 w-4" />
            New source
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>
            {sources.length} source{sources.length === 1 ? "" : "s"}
          </CardTitle>
          <CardDescription>
            Click a row to edit. Deleting a source unlinks it from items but
            doesn't delete the items.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {isLoading ? (
            <LoadingRegion label="Loading sources" className="px-4">
              <TableLoadingSkeleton rows={5} columns={4} />
            </LoadingRegion>
          ) : error ? (
            <div className="py-12 text-center text-sm text-destructive">
              Failed to load sources: {String(error)}
            </div>
          ) : sources.length === 0 ? (
            <EmptyState
              icon={MapPin}
              title="No sources yet"
              description="Track where your inventory comes from. Add a source manually, or they'll be auto-created when you import items."
              action={{
                label: "New source",
                onClick: () => setEditing({ ...EMPTY }),
                icon: Plus,
              }}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead className="text-right">Items</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sources.map((s) => (
                  <ClickableRow
                    key={s.id}
                    className="hover:bg-muted/30"
                    onActivate={() =>
                      setEditing({
                        id: s.id,
                        name: s.name,
                        source_type: s.source_type,
                        location: s.location ?? "",
                        notes: s.notes ?? "",
                      })
                    }
                    activateLabel={`Edit ${s.name}`}
                  >
                    <TableCell className="font-medium">{s.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {FLIPDESK_SOURCE_TYPE_LABELS[s.source_type]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {s.location ?? ""}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {itemCountBySource.get(s.id) ?? 0}
                    </TableCell>
                    <TableCell
                      className="text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() =>
                          setEditing({
                            id: s.id,
                            name: s.name,
                            source_type: s.source_type,
                            location: s.location ?? "",
                            notes: s.notes ?? "",
                          })
                        }
                        aria-label={`Edit ${s.name}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive"
                        onClick={() => setConfirmDelete(s)}
                        aria-label={`Delete ${s.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </ClickableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <SourceEditDialog
        state={editing}
        onChange={setEditing}
        onSave={save}
        saving={saving}
      />

      <AlertDialog
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete source?</AlertDialogTitle>
            <AlertDialogDescription>
              "{confirmDelete?.name}" will be removed.{" "}
              {confirmDelete &&
                (itemCountBySource.get(confirmDelete.id) ?? 0) > 0 && (
                  <>
                    <strong>
                      {itemCountBySource.get(confirmDelete.id)} item
                      {itemCountBySource.get(confirmDelete.id) === 1
                        ? ""
                        : "s"}{" "}
                      will be unlinked
                    </strong>{" "}
                    (the items themselves are kept). This can't be undone.
                  </>
                )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={performDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete source
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SourceEditDialog({
  state,
  onChange,
  onSave,
  saving,
}: {
  state: FormState | null;
  onChange: (s: FormState | null) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const [draft, setDraft] = useState<FormState | null>(state);

  // Sync draft when state changes from parent (open/close, switch row)
  useEffect(() => {
    setDraft(state);
  }, [state]);

  // When user types, mirror back to parent so save() sees current values
  useEffect(() => {
    if (draft && state && draft !== state) {
      onChange(draft);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  if (!draft || !state) return null;

  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onChange(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{state.id ? "Edit source" : "New source"}</DialogTitle>
          <DialogDescription>
            Sources are linked to items so you can attribute ROI by where you
            sourced them.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="source-name">Name *</Label>
            <Input
              id="source-name"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="e.g. Goodwill SE 14th"
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="source-type">Type</Label>
            <Select
              value={draft.source_type}
              onValueChange={(v) =>
                setDraft({ ...draft, source_type: v as FlipdeskSourceType })
              }
            >
              <SelectTrigger id="source-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FLIPDESK_SOURCE_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {FLIPDESK_SOURCE_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="source-location">Location</Label>
            <Input
              id="source-location"
              value={draft.location}
              onChange={(e) => setDraft({ ...draft, location: e.target.value })}
              placeholder="Address, URL, or city"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="source-notes">Notes</Label>
            <Textarea
              id="source-notes"
              value={draft.notes}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              rows={3}
              placeholder="Best days to visit, contacts, etc."
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onChange(null)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={onSave} disabled={saving || !draft.name.trim()}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {state.id ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
