import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Save, Loader2, ArrowLeft } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { useSources } from "@/hooks/use-sources";
import {
  ITEM_CATEGORIES,
  ITEM_STATUSES,
  ITEM_STATUS_LABELS,
} from "@/lib/constants";
import type {
  InventoryItemInsert,
  ItemStatus,
  ItemCategory,
} from "@/types/database";

interface FormState {
  title: string;
  sku: string;
  container: string;
  brand: string;
  style: string;
  size: string;
  color: string;
  material: string;
  item_category: ItemCategory | "";
  source_id: string;
  source_new: string; // new source name (used when source_id === "__new")
  sourced_by: string;
  purchase_date: string;
  purchase_price: string;
  description: string;
  condition_notes: string;
  status: ItemStatus;
}

const INITIAL: FormState = {
  title: "",
  sku: "",
  container: "",
  brand: "",
  style: "",
  size: "",
  color: "",
  material: "",
  item_category: "",
  source_id: "",
  source_new: "",
  sourced_by: "",
  purchase_date: new Date().toISOString().slice(0, 10),
  purchase_price: "",
  description: "",
  condition_notes: "",
  status: "cataloged",
};

function priceOrNull(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function trimOrNull(v: string): string | null {
  const t = v.trim();
  return t === "" ? null : t;
}

export function FlipdeskIntakePage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const { data: sources = [] } = useSources();
  const [form, setForm] = useState<FormState>(INITIAL);
  const [saving, setSaving] = useState(false);

  function patch<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function save(goBackToList: boolean) {
    if (!user) {
      toast.error("You must be signed in.");
      return;
    }
    if (!form.title.trim()) {
      toast.error("Title is required.");
      return;
    }
    if (form.source_id === "__new" && !form.source_new.trim()) {
      toast.error("Enter a name for the new source.");
      return;
    }

    setSaving(true);
    try {
      // Resolve source: existing id, new (via RPC), or none.
      let sourceId: string | null = null;
      if (form.source_id === "__new" && form.source_new.trim()) {
        const supabaseAny = supabase as unknown as {
          rpc: (
            fn: string,
            args: Record<string, unknown>,
          ) => Promise<{ data: string | null; error: Error | null }>;
        };
        const { data, error } = await supabaseAny.rpc(
          "get_or_create_source",
          {
            p_user_id: user.id,
            p_name: form.source_new.trim(),
            p_source_type: "other",
          },
        );
        if (error) throw error;
        sourceId = data;
      } else if (form.source_id && form.source_id !== "__none") {
        sourceId = form.source_id;
      }

      const insert: InventoryItemInsert = {
        user_id: user.id,
        title: form.title.trim(),
        sku: trimOrNull(form.sku),
        container: trimOrNull(form.container),
        brand: trimOrNull(form.brand),
        style: trimOrNull(form.style),
        size: trimOrNull(form.size),
        color: trimOrNull(form.color),
        material: trimOrNull(form.material),
        item_category: form.item_category === "" ? null : form.item_category,
        source_id: sourceId,
        sourced_by: trimOrNull(form.sourced_by),
        acquired_date: form.purchase_date || null,
        acquired_price: priceOrNull(form.purchase_price),
        description: trimOrNull(form.description),
        condition_notes: trimOrNull(form.condition_notes),
        status: form.status,
      };

      const { data: row, error } = await supabase
        .from("inventory_items")
        .insert(insert as never)
        .select("id")
        .single();
      if (error) throw error;
      const newId = (row as { id: string } | null)?.id;

      await qc.invalidateQueries({ queryKey: ["items_full"] });
      await qc.invalidateQueries({ queryKey: ["sources"] });

      toast.success(`Added "${form.title.trim()}".`);

      if (goBackToList) {
        navigate(
          newId
            ? `/dashboard/flipdesk/items?focus=${newId}`
            : "/dashboard/flipdesk/items",
        );
      } else {
        // Reset to add another, keeping source + container + sourced_by
        // (most common scenario: cataloging a batch from the same trip)
        setForm({
          ...INITIAL,
          source_id: form.source_id === "__new" ? "" : form.source_id,
          container: form.container,
          sourced_by: form.sourced_by,
          purchase_date: form.purchase_date,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Save failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/dashboard/flipdesk/items")}
          aria-label="Back to items"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">New item</h1>
          <p className="text-sm text-muted-foreground">
            Quick intake form. Save & Add another to catalog a batch from the
            same source.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Item info</CardTitle>
          <CardDescription>
            Only title is required. Everything else can be filled in later.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Title *"
              value={form.title}
              onChange={(v) => patch("title", v)}
              placeholder="e.g. Lululemon Align Pant"
            />
            <Field
              label="SKU / Item #"
              value={form.sku}
              onChange={(v) => patch("sku", v)}
              placeholder="optional"
            />
            <Field
              label="Brand"
              value={form.brand}
              onChange={(v) => patch("brand", v)}
            />
            <Field
              label="Style"
              value={form.style}
              onChange={(v) => patch("style", v)}
              placeholder="e.g. Align Pant 25 inch"
            />
            <Field
              label="Size"
              value={form.size}
              onChange={(v) => patch("size", v)}
            />
            <Field
              label="Color"
              value={form.color}
              onChange={(v) => patch("color", v)}
            />
            <div className="space-y-1">
              <Label>Category</Label>
              <Select
                value={form.item_category || "__none"}
                onValueChange={(v) =>
                  patch(
                    "item_category",
                    v === "__none" ? "" : (v as ItemCategory),
                  )
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">— None —</SelectItem>
                  {ITEM_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Field
              label="Material"
              value={form.material}
              onChange={(v) => patch("material", v)}
              placeholder="e.g. cotton, 90% nylon"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sourcing</CardTitle>
          <CardDescription>
            Where this came from. Pick from existing sources or add a new one.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Source</Label>
              <Select
                value={form.source_id || "__none"}
                onValueChange={(v) =>
                  patch("source_id", v === "__none" ? "" : v)
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">— None —</SelectItem>
                  <SelectItem value="__new">+ New source…</SelectItem>
                  {sources.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {form.source_id === "__new" && (
                <Input
                  className="mt-2"
                  placeholder="New source name (e.g. Goodwill SE 14th)"
                  value={form.source_new}
                  onChange={(e) => patch("source_new", e.target.value)}
                />
              )}
            </div>
            <Field
              label="Sourced By"
              value={form.sourced_by}
              onChange={(v) => patch("sourced_by", v)}
              placeholder="e.g. Dan, Spouse, Joint"
            />
            <Field
              label="Purchase Date"
              value={form.purchase_date}
              onChange={(v) => patch("purchase_date", v)}
              type="date"
            />
            <Field
              label="Purchase Price"
              value={form.purchase_price}
              onChange={(v) => patch("purchase_price", v)}
              type="number"
              placeholder="0.00"
            />
            <Field
              label="Container / Bin"
              value={form.container}
              onChange={(v) => patch("container", v)}
              placeholder="e.g. A1, Closet shelf 3"
            />
            <div className="space-y-1">
              <Label>Status</Label>
              <Select
                value={form.status}
                onValueChange={(v) => patch("status", v as ItemStatus)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ITEM_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {ITEM_STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Notes</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label>Description (public — for listing)</Label>
            <Textarea
              value={form.description}
              onChange={(e) => patch("description", e.target.value)}
              rows={3}
              placeholder="What buyers should see. Brand, fit, condition summary."
            />
          </div>
          <div className="space-y-1">
            <Label>Internal Notes</Label>
            <Textarea
              value={form.condition_notes}
              onChange={(e) => patch("condition_notes", e.target.value)}
              rows={3}
              placeholder="Private notes about defects, source context, etc."
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="outline"
          onClick={() => navigate("/dashboard/flipdesk/items")}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button
          variant="outline"
          onClick={() => save(false)}
          disabled={saving}
        >
          {saving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Plus className="mr-2 h-4 w-4" />
          )}
          Save & Add another
        </Button>
        <Button onClick={() => save(true)} disabled={saving}>
          {saving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          Save & View items
        </Button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "date" | "number";
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}
