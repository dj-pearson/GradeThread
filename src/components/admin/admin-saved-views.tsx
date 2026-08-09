import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookMarked, ChevronDown, Plus, Trash2 } from "lucide-react";
import { edgeFetch } from "@/lib/edge-fetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAdminSavedViews } from "@/hooks/use-admin-saved-views";

// US-909: reusable "saved views" control for the admin list pages. The owning
// page passes its current filter object + an onApply callback; the component
// lists this admin's saved views (private), applies one on click, saves the
// current filters as a new named view, and deletes views. All persistence goes
// through the admin-scoped /api/admin/views endpoints.
export function AdminSavedViews({
  surface,
  currentFilter,
  onApply,
}: {
  surface: string;
  currentFilter: Record<string, unknown>;
  onApply: (filter: Record<string, unknown>) => void;
}) {
  const qc = useQueryClient();
  const { data: views = [] } = useAdminSavedViews(surface);
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Give the view a name.");
      return;
    }
    setBusy(true);
    try {
      const res = await edgeFetch("/api/admin/views", {
        method: "POST",
        json: { surface, name: trimmed, filter: currentFilter },
        silentGate: true,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not save view");
      await qc.invalidateQueries({ queryKey: ["admin-saved-views", surface] });
      toast.success(`Saved view "${trimmed}".`);
      setName("");
      setSaveOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save view");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string, viewName: string) {
    try {
      const res = await edgeFetch(`/api/admin/views/${id}`, {
        method: "DELETE",
        silentGate: true,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not delete view");
      await qc.invalidateQueries({ queryKey: ["admin-saved-views", surface] });
      toast.success(`Deleted "${viewName}".`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete view");
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <BookMarked className="h-3.5 w-3.5" />
            <span className="ml-1">Views</span>
            {views.length > 0 && (
              <span className="ml-1 text-muted-foreground">({views.length})</span>
            )}
            <ChevronDown className="ml-1 h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>Saved views</DropdownMenuLabel>
          {views.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              No saved views yet.
            </div>
          ) : (
            views.map((v) => (
              <DropdownMenuItem
                key={v.id}
                onSelect={(e) => {
                  e.preventDefault();
                  onApply(v.filter);
                }}
                className="flex items-center justify-between gap-2"
              >
                <span className="truncate">{v.name}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void remove(v.id, v.name);
                  }}
                  className="text-muted-foreground transition-colors hover:text-destructive"
                  aria-label={`Delete view ${v.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setSaveOpen(true);
            }}
          >
            <Plus className="mr-2 h-3.5 w-3.5" />
            Save current filters…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Save view</DialogTitle>
            <DialogDescription>
              Save the current filters as a named view you can return to. Private
              to you.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="asv-name">Name</Label>
            <Input
              id="asv-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Open urgent tickets"
              maxLength={80}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim() && !busy) void save();
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSaveOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={busy || !name.trim()}>
              {busy ? "Saving…" : "Save view"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
