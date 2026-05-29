import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save, AlertTriangle, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { supabase } from "@/lib/supabase";
import { EBAY_CONDITION_OPTIONS } from "@/lib/constants";
import { cn } from "@/lib/utils";

// AutoLister bulk spreadsheet editor (US-320). Edit a whole generated batch in
// a grid — inline title/price/condition/quantity/best-offer — with bulk-apply
// actions, then save everything at once. Scoped to one batch's drafts.

const TITLE_MAX = 80;

interface DraftRow {
  id: string;
  inventory_item_id: string;
  listing_title: string | null;
  listing_price: number | null;
  ebay_condition: string | null;
  quantity: number | null;
  best_offer_enabled: boolean | null;
}

interface EditRow {
  id: string;
  itemId: string;
  title: string;
  price: string;
  condition: string;
  quantity: string;
  bestOffer: boolean;
  dirty: boolean;
}

function roundTo99(p: number): number {
  if (p < 1) return Math.round(p * 100) / 100;
  return Math.floor(p) + 0.99;
}

export function FlipdeskAutolisterBulkEditPage() {
  const [params] = useSearchParams();
  const batchId = params.get("batch");
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["autolister_batch_drafts", batchId],
    enabled: !!batchId,
    queryFn: async (): Promise<DraftRow[]> => {
      const { data: rows, error: err } = await supabase
        .from("listings")
        .select(
          "id, inventory_item_id, listing_title, listing_price, ebay_condition, quantity, best_offer_enabled",
        )
        .eq("batch_id", batchId!)
        .eq("listing_status", "draft");
      if (err) throw err;
      return (rows ?? []) as DraftRow[];
    },
  });

  const itemIds = useMemo(
    () => (data ?? []).map((r) => r.inventory_item_id),
    [data],
  );
  const { data: titles = {} } = useQuery<Record<string, string>>({
    queryKey: ["autolister_bulk_titles", batchId, itemIds.length],
    enabled: itemIds.length > 0,
    queryFn: async () => {
      const { data: rows } = await supabase
        .from("inventory_items")
        .select("id, title")
        .in("id", itemIds);
      const map: Record<string, string> = {};
      for (const r of (rows ?? []) as Array<{ id: string; title: string }>) {
        map[r.id] = r.title;
      }
      return map;
    },
  });

  const [rows, setRows] = useState<EditRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [markupPct, setMarkupPct] = useState("");
  const [bulkCondition, setBulkCondition] = useState("");
  const [bulkQty, setBulkQty] = useState("");

  // Seed editable rows once the drafts load.
  useEffect(() => {
    if (!data) return;
    setRows(
      data.map((r) => ({
        id: r.id,
        itemId: r.inventory_item_id,
        title: r.listing_title ?? "",
        price: r.listing_price != null ? String(r.listing_price) : "",
        condition: r.ebay_condition ?? "",
        quantity: r.quantity != null ? String(r.quantity) : "1",
        bestOffer: r.best_offer_enabled ?? false,
        dirty: false,
      })),
    );
  }, [data]);

  const dirtyCount = rows.filter((r) => r.dirty).length;
  const targetIds = selected.size > 0 ? selected : new Set(rows.map((r) => r.id));

  function patchRow(id: string, patch: Partial<EditRow>) {
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch, dirty: true } : r)),
    );
  }

  function applyToTargets(fn: (r: EditRow) => Partial<EditRow>) {
    setRows((prev) =>
      prev.map((r) => (targetIds.has(r.id) ? { ...r, ...fn(r), dirty: true } : r)),
    );
  }

  function applyMarkup() {
    const pct = Number.parseFloat(markupPct);
    if (!Number.isFinite(pct)) return;
    applyToTargets((r) => {
      const base = Number.parseFloat(r.price);
      if (!Number.isFinite(base)) return {};
      return { price: (base * (1 + pct / 100)).toFixed(2) };
    });
  }

  function applyRound99() {
    applyToTargets((r) => {
      const base = Number.parseFloat(r.price);
      if (!Number.isFinite(base)) return {};
      return { price: roundTo99(base).toFixed(2) };
    });
  }

  async function saveAll() {
    const dirty = rows.filter((r) => r.dirty);
    if (dirty.length === 0) {
      toast.info("No changes to save.");
      return;
    }
    setSaving(true);
    try {
      const CONCURRENCY = 5;
      for (let i = 0; i < dirty.length; i += CONCURRENCY) {
        await Promise.all(
          dirty.slice(i, i + CONCURRENCY).map(async (r) => {
            const price = Number.parseFloat(r.price);
            const qty = Number.parseInt(r.quantity, 10);
            const { error: upErr } = await supabase
              .from("listings")
              .update({
                listing_title: r.title.trim() || null,
                listing_price: Number.isFinite(price) ? price : 0,
                ebay_condition: r.condition || null,
                quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
                best_offer_enabled: r.bestOffer,
                price_is_estimated: false,
              } as never)
              .eq("id", r.id);
            if (upErr) throw upErr;
          }),
        );
      }
      setRows((prev) => prev.map((r) => ({ ...r, dirty: false })));
      await qc.invalidateQueries({ queryKey: ["autolister_batch_drafts", batchId] });
      toast.success(`Saved ${dirty.length} listing${dirty.length === 1 ? "" : "s"}.`);
    } catch (err) {
      toast.error(
        `Save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Roll back to the server's truth.
      await qc.invalidateQueries({ queryKey: ["autolister_batch_drafts", batchId] });
    } finally {
      setSaving(false);
    }
  }

  function rowIssues(r: EditRow): string[] {
    const issues: string[] = [];
    if (!r.title.trim()) issues.push("Title is empty");
    else if (r.title.length > TITLE_MAX) issues.push(`Title over ${TITLE_MAX} chars`);
    const price = Number.parseFloat(r.price);
    if (!Number.isFinite(price) || price <= 0) issues.push("Price not set");
    if (!r.condition) issues.push("No condition");
    return issues;
  }

  if (!batchId) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        No batch specified.{" "}
        <Link to="/dashboard/flipdesk/autolister" className="text-primary underline">
          Start a new batch
        </Link>
        .
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading drafts…
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-12 text-center text-sm text-destructive">
        {error instanceof Error ? error.message : "Could not load drafts."}
      </div>
    );
  }

  const allSelected = rows.length > 0 && selected.size === rows.length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Bulk edit drafts</h1>
          <p className="text-sm text-muted-foreground">
            {rows.length} draft{rows.length === 1 ? "" : "s"} in this batch.
            Edit inline or apply changes to selected rows.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline">
            <Link to={`/dashboard/flipdesk/autolister/queue?batch=${batchId}`}>
              Back to queue
              <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
          <Button onClick={saveAll} disabled={saving || dirtyCount === 0}>
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save {dirtyCount > 0 ? `(${dirtyCount})` : ""}
          </Button>
        </div>
      </div>

      {/* Bulk-apply toolbar */}
      <Card className="flex flex-wrap items-end gap-4 p-3">
        <div className="text-xs text-muted-foreground">
          Applies to{" "}
          <strong>{selected.size > 0 ? `${selected.size} selected` : "all rows"}</strong>
        </div>
        <div className="flex items-end gap-1.5">
          <div>
            <label className="mb-1 block text-[10px] uppercase text-muted-foreground">
              Price markup %
            </label>
            <Input
              type="number"
              value={markupPct}
              onChange={(e) => setMarkupPct(e.target.value)}
              className="h-8 w-24"
              placeholder="e.g. 10"
            />
          </div>
          <Button size="sm" variant="secondary" onClick={applyMarkup}>
            Apply
          </Button>
          <Button size="sm" variant="secondary" onClick={applyRound99}>
            Round to .99
          </Button>
        </div>
        <div className="flex items-end gap-1.5">
          <div>
            <label className="mb-1 block text-[10px] uppercase text-muted-foreground">
              Condition
            </label>
            <select
              value={bulkCondition}
              onChange={(e) => setBulkCondition(e.target.value)}
              className="h-8 w-44 rounded-md border border-input bg-transparent px-2 text-sm"
            >
              <option value="">Select…</option>
              {EBAY_CONDITION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={!bulkCondition}
            onClick={() => applyToTargets(() => ({ condition: bulkCondition }))}
          >
            Apply
          </Button>
        </div>
        <div className="flex items-end gap-1.5">
          <div>
            <label className="mb-1 block text-[10px] uppercase text-muted-foreground">
              Quantity
            </label>
            <Input
              type="number"
              min="1"
              value={bulkQty}
              onChange={(e) => setBulkQty(e.target.value)}
              className="h-8 w-20"
              placeholder="1"
            />
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={!bulkQty}
            onClick={() => applyToTargets(() => ({ quantity: bulkQty }))}
          >
            Apply
          </Button>
        </div>
        <div className="flex items-end gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => applyToTargets(() => ({ bestOffer: true }))}
          >
            Enable Best Offer
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => applyToTargets(() => ({ bestOffer: false }))}
          >
            Disable
          </Button>
        </div>
      </Card>

      {/* Grid */}
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="w-8 p-2">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked ? new Set(rows.map((r) => r.id)) : new Set(),
                    )
                  }
                  aria-label="Select all"
                />
              </th>
              <th className="p-2">Title</th>
              <th className="w-28 p-2">Price</th>
              <th className="w-44 p-2">Condition</th>
              <th className="w-16 p-2">Qty</th>
              <th className="w-20 p-2">Best Offer</th>
              <th className="w-10 p-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const issues = rowIssues(r);
              return (
                <tr key={r.id} className="border-b last:border-0 align-top">
                  <td className="p-2">
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={(e) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(r.id);
                          else next.delete(r.id);
                          return next;
                        })
                      }
                      aria-label="Select row"
                    />
                  </td>
                  <td className="p-2">
                    <Input
                      value={r.title}
                      onChange={(e) => patchRow(r.id, { title: e.target.value })}
                      placeholder={titles[r.itemId] ?? "Title"}
                      className={cn(
                        "h-8",
                        r.title.length > TITLE_MAX && "border-destructive",
                      )}
                    />
                    <span
                      className={cn(
                        "text-[10px]",
                        r.title.length > TITLE_MAX
                          ? "text-destructive"
                          : "text-muted-foreground",
                      )}
                    >
                      {r.title.length}/{TITLE_MAX}
                    </span>
                  </td>
                  <td className="p-2">
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={r.price}
                      onChange={(e) => patchRow(r.id, { price: e.target.value })}
                      className="h-8"
                      placeholder="0.00"
                    />
                  </td>
                  <td className="p-2">
                    <select
                      value={r.condition}
                      onChange={(e) => patchRow(r.id, { condition: e.target.value })}
                      className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                    >
                      <option value="">—</option>
                      {EBAY_CONDITION_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="p-2">
                    <Input
                      type="number"
                      min="1"
                      value={r.quantity}
                      onChange={(e) => patchRow(r.id, { quantity: e.target.value })}
                      className="h-8"
                    />
                  </td>
                  <td className="p-2 text-center">
                    <input
                      type="checkbox"
                      checked={r.bestOffer}
                      onChange={(e) => patchRow(r.id, { bestOffer: e.target.checked })}
                      aria-label="Best offer"
                    />
                  </td>
                  <td className="p-2">
                    {issues.length > 0 && (
                      <span title={issues.join(" • ")}>
                        <AlertTriangle className="h-4 w-4 text-amber-500" />
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="p-6 text-center text-sm text-muted-foreground">
                  No drafts in this batch.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
