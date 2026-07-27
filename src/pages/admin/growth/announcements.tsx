import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/ui/page-header";
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
import { Plus, Trash2, Pencil, Megaphone } from "lucide-react";

type Variant = "info" | "success" | "warning" | "promo";

interface Announcement {
  id: string;
  title: string;
  body: string;
  variant: Variant;
  cta_label: string | null;
  cta_url: string | null;
  segment_id: string | null;
  starts_at: string;
  ends_at: string | null;
  dismissible: boolean;
  priority: number;
  is_active: boolean;
}
interface Segment { id: string; name: string }

const VARIANT_COLOR: Record<Variant, string> = {
  info: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
  success: "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-300",
  warning: "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
  promo: "bg-brand-red/15 text-brand-red-text",
};

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 16);
}

function EditorDialog({
  open,
  onOpenChange,
  editing,
  segments,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  editing: Announcement | null;
  segments: Segment[];
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState(editing?.title ?? "");
  const [body, setBody] = useState(editing?.body ?? "");
  const [variant, setVariant] = useState<Variant>(editing?.variant ?? "info");
  const [ctaLabel, setCtaLabel] = useState(editing?.cta_label ?? "");
  const [ctaUrl, setCtaUrl] = useState(editing?.cta_url ?? "");
  const [segmentId, setSegmentId] = useState(editing?.segment_id ?? "all");
  const [startsAt, setStartsAt] = useState(toLocalInput(editing?.starts_at ?? null));
  const [endsAt, setEndsAt] = useState(toLocalInput(editing?.ends_at ?? null));
  const [dismissible, setDismissible] = useState(editing?.dismissible ?? true);
  const [priority, setPriority] = useState(editing?.priority ?? 0);
  const [isActive, setIsActive] = useState(editing?.is_active ?? true);

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        title,
        body,
        variant,
        cta_label: ctaLabel || null,
        cta_url: ctaUrl || null,
        segment_id: segmentId === "all" ? null : segmentId,
        starts_at: startsAt ? new Date(startsAt).toISOString() : new Date().toISOString(),
        ends_at: endsAt ? new Date(endsAt).toISOString() : null,
        dismissible,
        priority,
        is_active: isActive,
      };
      const res = await edgeFetch(
        editing ? `/api/admin/growth/announcements/${editing.id}` : "/api/admin/growth/announcements",
        { method: editing ? "PATCH" : "POST", json: payload },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      return json;
    },
    onSuccess: () => {
      toast.success(editing ? "Announcement updated" : "Announcement created");
      qc.invalidateQueries({ queryKey: ["growth-announcements"] });
      onOpenChange(false);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit announcement" : "New announcement"}</DialogTitle>
          <DialogDescription>In-app banner shown to targeted users for a window.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Body</Label>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Variant</Label>
              <Select value={variant} onValueChange={(v) => setVariant(v as Variant)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="info">Info</SelectItem>
                  <SelectItem value="success">Success</SelectItem>
                  <SelectItem value="warning">Warning</SelectItem>
                  <SelectItem value="promo">Promo</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Audience</Label>
              <Select value={segmentId} onValueChange={setSegmentId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Everyone</SelectItem>
                  {segments.map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Button label (optional)</Label>
              <Input value={ctaLabel} onChange={(e) => setCtaLabel(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Button URL (optional)</Label>
              <Input value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Starts</Label>
              <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Ends (optional)</Label>
              <Input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-2">
              <Label>Priority</Label>
              <Input type="number" value={priority} onChange={(e) => setPriority(Number(e.target.value))} />
            </div>
            <label className="flex items-center gap-2 pt-7 text-sm">
              <input type="checkbox" checked={dismissible} onChange={(e) => setDismissible(e.target.checked)} />
              Dismissible
            </label>
            <label className="flex items-center gap-2 pt-7 text-sm">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
              Active
            </label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={!title.trim() || !body.trim() || save.isPending}>
            {save.isPending ? "Saving…" : editing ? "Save changes" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function GrowthAnnouncementsPage() {
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Announcement | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["growth-announcements"],
    queryFn: async (): Promise<{ announcements: Announcement[] }> => {
      const res = await edgeFetch("/api/admin/growth/announcements");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Failed to load announcements");
      return json;
    },
  });
  const { data: segData } = useQuery({
    queryKey: ["growth-segments"],
    queryFn: async (): Promise<{ segments: Segment[] }> => {
      const res = await edgeFetch("/api/admin/growth/segments");
      return res.ok ? res.json() : { segments: [] };
    },
  });

  const del = useMutation({
    mutationFn: async (id: string) => {
      const res = await edgeFetch(`/api/admin/growth/announcements/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Delete failed");
    },
    onSuccess: () => {
      toast.success("Deleted");
      qc.invalidateQueries({ queryKey: ["growth-announcements"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Megaphone}
        title="Announcements"
        subtitle="In-app banners — no deploy required."
        actions={
          <Button onClick={() => { setEditing(null); setDialogOpen(true); }}>
            <Plus className="mr-1 h-4 w-4" /> New announcement
          </Button>
        }
      />

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : !data || data.announcements.length === 0 ? (
        <Card><CardContent className="p-10 text-center text-muted-foreground">No announcements yet.</CardContent></Card>
      ) : (
        <div className="space-y-3">
          {data.announcements.map((a) => (
            <Card key={a.id}>
              <CardContent className="flex items-start justify-between gap-4 p-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge className={VARIANT_COLOR[a.variant]} variant="secondary">{a.variant}</Badge>
                    <span className="font-semibold">{a.title}</span>
                    {!a.is_active && <Badge variant="outline">inactive</Badge>}
                    {a.priority !== 0 && <span className="text-xs text-muted-foreground">priority {a.priority}</span>}
                  </div>
                  <p className="text-sm text-muted-foreground">{a.body}</p>
                  <p className="text-xs text-muted-foreground">
                    {a.segment_id ? "Targeted segment" : "Everyone"}
                    {a.ends_at ? ` · ends ${new Date(a.ends_at).toLocaleString()}` : ""}
                  </p>
                </div>
                <div className="flex flex-shrink-0 gap-1">
                  <Button variant="outline" size="sm" onClick={() => { setEditing(a); setDialogOpen(true); }}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    disabled={del.isPending}
                    onClick={() => { if (confirm(`Delete "${a.title}"?`)) del.mutate(a.id); }}
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
          segments={segData?.segments ?? []}
        />
      )}
    </div>
  );
}
