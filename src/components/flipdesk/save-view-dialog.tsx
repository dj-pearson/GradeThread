import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import type { FilterQuery } from "@/lib/item-filter";
import type { SavedViewInsert } from "@/types/database";

export function SaveViewDialog({
  open,
  onOpenChange,
  query,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  query: FilterQuery;
}) {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [pinned, setPinned] = useState(true);
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!user) return;
    if (!name.trim()) {
      toast.error("Give the view a name.");
      return;
    }
    setSaving(true);
    try {
      const insert: SavedViewInsert = {
        user_id: user.id,
        name: name.trim(),
        emoji: emoji.trim() || null,
        query_json: query as unknown as Record<string, unknown>,
        pinned,
        scope: "items",
      };
      const { error } = await supabase
        .from("flipdesk_saved_views")
        .insert(insert as never);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: ["saved_views"] });
      toast.success(`Saved view "${name.trim()}".`);
      setName("");
      setEmoji("");
      setPinned(true);
      onOpenChange(false);
    } catch (err) {
      toast.error(
        `Save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Save as view</DialogTitle>
          <DialogDescription>
            Save the current filter as a named view you can return to.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Cheap Nike to list"
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <Label>Emoji (optional)</Label>
            <Input
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
              placeholder="🔥"
              maxLength={4}
              className="w-20"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(e) => setPinned(e.target.checked)}
              className="h-4 w-4"
            />
            Pin to sidebar
          </label>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || !name.trim()}>
            {saving ? "Saving…" : "Save view"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
