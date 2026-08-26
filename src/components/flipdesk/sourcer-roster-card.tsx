import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Check,
  Loader2,
  Pencil,
  Plus,
  Undo2,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/lib/supabase";
import { useWorkspace } from "@/hooks/use-workspace";
import { useAddSourcer, useSourcers } from "@/hooks/use-sourcers";

// US-2886: manage WHO the "Sourced by" picker offers.
//
// Teammates land here on their own (the 00672 triggers add the workspace owner
// and every workspace_members row). Everyone else, a spouse or a picker or
// Joint, is added by hand: here, or inline from the composer.

export function SourcerRosterCard() {
  const { workspaceOwnerId, can } = useWorkspace();
  const canManage = can("manage_inventory");
  const qc = useQueryClient();
  const { rows, sourcers, isLoading } = useSourcers({ includeArchived: true });
  const addSourcer = useAddSourcer();

  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  // How many items each name is actually on. Answers "is this one safe to
  // archive" without a trip to the inventory table.
  const { data: usageRows } = useQuery({
    queryKey: ["sourced_by_counts", workspaceOwnerId],
    enabled: !!workspaceOwnerId,
    queryFn: async (): Promise<Array<{ sourced_by: string | null }>> => {
      const { data, error } = await supabase
        .from("inventory_items")
        .select("sourced_by")
        .eq("user_id", workspaceOwnerId as string);
      if (error) throw error;
      return (data ?? []) as Array<{ sourced_by: string | null }>;
    },
  });

  const usage = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of usageRows ?? []) {
      const name = (r.sourced_by ?? "").trim().toLowerCase();
      if (!name) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  }, [usageRows]);

  const archivedById = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const r of rows) m.set(r.id, r.archived_at);
    return m;
  }, [rows]);

  const active = sourcers.filter((s) => !archivedById.get(s.id));
  const archived = sourcers.filter((s) => archivedById.get(s.id));

  function countFor(name: string): number {
    return usage.get(name.toLowerCase()) ?? 0;
  }

  async function invalidate() {
    await qc.invalidateQueries({ queryKey: ["sourcers"] });
    await qc.invalidateQueries({ queryKey: ["sourced_by_counts"] });
  }

  async function handleAdd() {
    const name = newName.trim();
    if (!name) return;
    setAdding(true);
    try {
      await addSourcer(name);
      setNewName("");
      toast.success(`Added ${name}.`);
    } catch {
      toast.error("Couldn't add that person.");
    } finally {
      setAdding(false);
    }
  }

  // Renaming rewrites the name on every item that carries it, which is the
  // point of having a roster at all: Tiff becoming Tiffany shouldn't leave two
  // people behind in the sourcing reports.
  async function handleRename(id: string, oldName: string) {
    const name = editName.trim();
    if (!name || name === oldName) {
      setEditingId(null);
      return;
    }
    if (!workspaceOwnerId) return;
    setBusyId(id);
    try {
      const { error } = await supabase
        .from("sourcers")
        .update({ name } as never)
        .eq("id", id);
      if (error) throw error;

      const { error: itemErr } = await supabase
        .from("inventory_items")
        .update({ sourced_by: name } as never)
        .eq("user_id", workspaceOwnerId)
        .ilike("sourced_by", oldName);
      if (itemErr) throw itemErr;

      await invalidate();
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      setEditingId(null);
      toast.success(`Renamed to ${name}.`);
    } catch {
      toast.error("Rename failed. That name may already be on the roster.");
    } finally {
      setBusyId(null);
    }
  }

  async function setArchived(id: string, archive: boolean) {
    setBusyId(id);
    try {
      const { error } = await supabase
        .from("sourcers")
        .update({
          archived_at: archive ? new Date().toISOString() : null,
        } as never)
        .eq("id", id);
      if (error) throw error;
      await invalidate();
    } catch {
      toast.error(archive ? "Couldn't archive." : "Couldn't restore.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          Sourced by
        </CardTitle>
        <CardDescription>
          The people the Sourced by picker offers. Everyone on your team is
          added here automatically. Add anyone else and they show up everywhere
          you catalog.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canManage && (
          <div className="flex items-center gap-2">
            <Input
              aria-label="New person name"
              placeholder="Add a person (e.g. Tiff)"
              value={newName}
              disabled={adding}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleAdd();
                }
              }}
            />
            <Button
              type="button"
              disabled={adding || newName.trim() === ""}
              onClick={() => void handleAdd()}
            >
              {adding ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Plus className="mr-2 h-4 w-4" />
              )}
              Add
            </Button>
          </div>
        )}

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : active.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nobody on the roster yet.
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {active.map((s) => {
              const count = countFor(s.name);
              const busy = busyId === s.id;
              return (
                <li
                  key={s.id}
                  className="flex items-center gap-2 px-3 py-2 text-sm"
                >
                  {editingId === s.id ? (
                    <>
                      <Input
                        autoFocus
                        aria-label={`Rename ${s.name}`}
                        value={editName}
                        disabled={busy}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void handleRename(s.id, s.name);
                          }
                          if (e.key === "Escape") setEditingId(null);
                        }}
                      />
                      <Button
                        type="button"
                        size="icon"
                        variant="secondary"
                        aria-label={`Save the new name for ${s.name}`}
                        disabled={busy}
                        onClick={() => void handleRename(s.id, s.name)}
                      >
                        {busy ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Check className="h-4 w-4" />
                        )}
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label={`Cancel renaming ${s.name}`}
                        disabled={busy}
                        onClick={() => setEditingId(null)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="font-medium">{s.name}</span>
                      {s.isYou && <Badge variant="secondary">You</Badge>}
                      {!s.isYou && s.memberUserId && (
                        <Badge variant="outline">Teammate</Badge>
                      )}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {count} item{count === 1 ? "" : "s"}
                      </span>
                      {canManage && (
                        <>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            aria-label={`Rename ${s.name}`}
                            onClick={() => {
                              setEditingId(s.id);
                              setEditName(s.name);
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            aria-label={`Archive ${s.name}`}
                            disabled={busy}
                            onClick={() => void setArchived(s.id, true)}
                          >
                            <Archive className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {archived.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              Archived. Hidden from the picker, still on past items.
            </p>
            <ul className="divide-y rounded-md border">
              {archived.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground"
                >
                  <span>{s.name}</span>
                  <span className="ml-auto text-xs">
                    {countFor(s.name)} item{countFor(s.name) === 1 ? "" : "s"}
                  </span>
                  {canManage && (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Restore ${s.name}`}
                      disabled={busyId === s.id}
                      onClick={() => void setArchived(s.id, false)}
                    >
                      <Undo2 className="h-4 w-4" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
