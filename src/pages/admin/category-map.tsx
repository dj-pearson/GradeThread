import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { edgeFetch } from "@/lib/edge-fetch";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Map, Plus, Pencil, Trash2, Search, Loader2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

// US-1563: editor over /api/admin/category-map (US-722). The
// marketplace_category_map table drives category suggestions in every seller's
// listing generation for the mapped platforms — an admin fix here benefits all
// sellers and makes repeat garment types cost ~0 AI. eBay/Shopify are managed
// elsewhere (Taxonomy API / free-form), mirroring the route's scope.

// Mirrors MAPPED_PLATFORMS on the edge — the route rejects anything else.
const PLATFORMS = ["poshmark", "mercari", "depop", "grailed"] as const;

interface Mapping {
  id: string;
  platform: string;
  gradethread_garment: string;
  platform_category: string;
  department: string | null;
  source: string;
  confidence: number | null;
  needs_confirmation: boolean;
  updated_at: string;
}

interface EditorState {
  platform: string;
  gradethread_garment: string;
  platform_category: string;
  department: string;
}

const EMPTY_EDITOR: EditorState = {
  platform: "poshmark",
  gradethread_garment: "",
  platform_category: "",
  department: "",
};

// Client-side mirror of the route's validateMapping — same failure messages so
// the operator sees identical feedback pre- and post-submit.
function validateEditor(e: EditorState): string | null {
  if (!(PLATFORMS as readonly string[]).includes(e.platform)) {
    return `platform must be one of: ${PLATFORMS.join(", ")}`;
  }
  if (!e.gradethread_garment.trim()) return "gradethread_garment is required";
  if (!e.platform_category.trim()) return "platform_category is required";
  return null;
}

export function AdminCategoryMapPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [platformFilter, setPlatformFilter] = useState("all");

  const [editorOpen, setEditorOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);
  const [editingExisting, setEditingExisting] = useState(false);
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Mapping | null>(null);
  const [deleting, setDeleting] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["admin-category-map"],
    queryFn: async (): Promise<Mapping[]> => {
      const res = await edgeFetch("/api/admin/category-map");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load category map.");
      return json.mappings ?? [];
    },
    staleTime: 30 * 1000,
  });

  const mappings = useMemo(() => {
    let rows = data ?? [];
    if (platformFilter !== "all") rows = rows.filter((m) => m.platform === platformFilter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter((m) =>
        m.gradethread_garment.includes(q) ||
        m.platform_category.toLowerCase().includes(q) ||
        (m.department ?? "").toLowerCase().includes(q)
      );
    }
    return rows;
  }, [data, platformFilter, search]);

  function openAdd() {
    setEditor({ ...EMPTY_EDITOR, platform: platformFilter !== "all" ? platformFilter : "poshmark" });
    setEditingExisting(false);
    setEditorOpen(true);
  }

  function openEdit(m: Mapping) {
    setEditor({
      platform: m.platform,
      gradethread_garment: m.gradethread_garment,
      platform_category: m.platform_category,
      department: m.department ?? "",
    });
    setEditingExisting(true);
    setEditorOpen(true);
  }

  async function save() {
    const invalid = validateEditor(editor);
    if (invalid) {
      toast.error(invalid);
      return;
    }
    setSaving(true);
    try {
      const res = await edgeFetch("/api/admin/category-map", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: editor.platform,
          gradethread_garment: editor.gradethread_garment.trim().toLowerCase(),
          platform_category: editor.platform_category.trim(),
          department: editor.department.trim() || null,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      toast.success("Mapping saved.");
      setEditorOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["admin-category-map"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save mapping.");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await edgeFetch(`/api/admin/category-map/${deleteTarget.id}`, {
        method: "DELETE",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      toast.success("Mapping removed — the seed/AI layer re-resolves on the next item.");
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["admin-category-map"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete mapping.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Map className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Category map</h1>
            <p className="text-sm text-muted-foreground">
              Garment-type → platform-category mappings that feed listing generation (Poshmark, Mercari, Depop, Grailed).
            </p>
          </div>
        </div>
        <Button onClick={openAdd}>
          <Plus className="mr-2 h-4 w-4" />
          Add mapping
        </Button>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative w-64">
          <Search
            aria-hidden="true"
            className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
          />
          <Input
            aria-label="Search garment / category"
            className="pl-8"
            placeholder="Search garment / category…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={platformFilter} onValueChange={setPlatformFilter}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All platforms</SelectItem>
            {PLATFORMS.map((p) => (
              <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : mappings.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">
              <p className="font-medium text-foreground">No mappings{search || platformFilter !== "all" ? " match your filters" : " yet"}.</p>
              <p className="mx-auto mt-2 max-w-md">
                Mappings translate GradeThread garment types (e.g. “hoodie”) into each platform's
                category path so listing generation suggests the right category without an AI call.
                Sellers' AI suggestions land here as <Badge variant="outline" className="text-xs">ai</Badge>{" "}
                rows awaiting confirmation; saving one converts it to an admin override.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Platform</TableHead>
                  <TableHead>Garment type</TableHead>
                  <TableHead>Platform category</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mappings.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="capitalize">{m.platform}</TableCell>
                    <TableCell className="font-medium">{m.gradethread_garment}</TableCell>
                    <TableCell className="max-w-[280px] truncate" title={m.platform_category}>
                      {m.platform_category}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{m.department ?? "—"}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-1.5">
                        <Badge variant={m.source === "admin" ? "secondary" : "outline"} className="text-xs">
                          {m.source}
                          {m.confidence != null ? ` · ${Math.round(m.confidence * 100)}%` : ""}
                        </Badge>
                        {m.needs_confirmation && (
                          <Badge className="bg-amber-100 text-amber-800 text-xs dark:bg-amber-950/50 dark:text-amber-300">
                            <AlertTriangle className="mr-1 h-3 w-3" />
                            confirm
                          </Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(m)} title={m.needs_confirmation ? "Review & confirm" : "Edit"}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(m)} title="Delete">
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingExisting ? "Edit mapping" : "Add mapping"}</DialogTitle>
            <DialogDescription>
              Saving stores an admin override (source becomes “admin”, confirmation cleared) used by
              every seller's listing generation.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Platform</Label>
              <Select
                value={editor.platform}
                onValueChange={(v) => setEditor({ ...editor, platform: v })}
                disabled={editingExisting}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map((p) => (
                    <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cm-garment">GradeThread garment type</Label>
              <Input
                id="cm-garment"
                placeholder="e.g. hoodie"
                value={editor.gradethread_garment}
                onChange={(e) => setEditor({ ...editor, gradethread_garment: e.target.value })}
                disabled={editingExisting}
                maxLength={80}
              />
              {!editingExisting && (
                <p className="text-xs text-muted-foreground">
                  Lowercased on save; one mapping per (platform, garment type) — saving an existing pair overwrites it.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cm-category">Platform category</Label>
              <Input
                id="cm-category"
                placeholder="e.g. Men > Shirts > Sweatshirts & Hoodies"
                value={editor.platform_category}
                onChange={(e) => setEditor({ ...editor, platform_category: e.target.value })}
                maxLength={200}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cm-department">Department (optional)</Label>
              <Input
                id="cm-department"
                placeholder="e.g. Men"
                value={editor.department}
                onChange={(e) => setEditor({ ...editor, department: e.target.value })}
                maxLength={60}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setEditorOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={saving || validateEditor(editor) !== null}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save mapping
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete mapping?</DialogTitle>
            <DialogDescription>
              {deleteTarget && (
                <>
                  <span className="capitalize">{deleteTarget.platform}</span> · “{deleteTarget.gradethread_garment}” →{" "}
                  “{deleteTarget.platform_category}”. The seed/AI layer re-resolves this garment type on the next item.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
