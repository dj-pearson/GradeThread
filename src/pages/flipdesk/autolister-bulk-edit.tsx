import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  Save,
  AlertTriangle,
  ArrowRight,
  ShieldCheck,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { supabase } from "@/lib/supabase";
import { edgeFetch } from "@/lib/edge-fetch";
import { useEbayCategorySuggest } from "@/hooks/use-ebay";
import { EBAY_CONDITION_OPTIONS, EBAY_DEPARTMENT_OPTIONS } from "@/lib/constants";
import { cn, isoToLocalInput, localInputToIso } from "@/lib/utils";

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
  scheduled_publish_at: string | null;
  platform_category_id: string | null;
  item_specifics_override: Record<string, string[]> | null;
}

interface EditRow {
  id: string;
  itemId: string;
  title: string;
  price: string;
  condition: string;
  quantity: string;
  bestOffer: boolean;
  scheduledAt: string;
  categoryId: string;
  // Human-readable category path for display (e.g. "…> Women > Women's Clothing").
  // Populated when the user picks via search; the DB only stores the leaf id, so
  // it's empty for categories loaded from the server until re-picked.
  categoryPath: string;
  // eBay item specifics edited inline. Department/Brand/Size/Color are the
  // required clothing aspects that most often block publish; they're merged into
  // item_specifics_override on save. A blank value falls back to the item's
  // derived column server-side. `specifics` holds the rest of the override
  // verbatim so the merge stays lossless.
  department: string;
  brand: string;
  size: string;
  color: string;
  specifics: Record<string, string[]>;
  // Server-side validation blockers (US-320) — populated by "Validate" actions.
  validationBlockers: string[] | null;
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
          "id, inventory_item_id, listing_title, listing_price, ebay_condition, quantity, best_offer_enabled, scheduled_publish_at, platform_category_id, item_specifics_override",
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
  // The item's structured attributes back the placeholders below: when a row's
  // Brand/Size/Color override is empty, the server derives the aspect from these
  // columns, so showing them as placeholders tells the seller what will be used.
  type ItemAttrs = {
    title: string;
    brand: string;
    size: string;
    color: string;
  };
  const { data: itemAttrs = {} } = useQuery<Record<string, ItemAttrs>>({
    queryKey: ["autolister_bulk_item_attrs", batchId, itemIds.length],
    enabled: itemIds.length > 0,
    queryFn: async () => {
      const { data: rows } = await supabase
        .from("inventory_items")
        .select("id, title, brand, size, color")
        .in("id", itemIds);
      const map: Record<string, ItemAttrs> = {};
      for (
        const r of (rows ?? []) as Array<
          {
            id: string;
            title: string | null;
            brand: string | null;
            size: string | null;
            color: string | null;
          }
        >
      ) {
        map[r.id] = {
          title: r.title ?? "",
          brand: r.brand ?? "",
          size: r.size ?? "",
          color: r.color ?? "",
        };
      }
      return map;
    },
  });

  const [rows, setRows] = useState<EditRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [markupPct, setMarkupPct] = useState("");
  const [bulkCondition, setBulkCondition] = useState("");
  const [bulkQty, setBulkQty] = useState("");
  const [bulkSchedule, setBulkSchedule] = useState("");
  const [bulkCategory, setBulkCategory] = useState<{
    id: string;
    path: string;
  } | null>(null);
  const [bulkDepartment, setBulkDepartment] = useState("");
  const [bulkBrand, setBulkBrand] = useState("");

  // Seed editable rows once the drafts load.
  useEffect(() => {
    if (!data) return;
    setRows(
      data.map((r) => {
        // Split the inline-editable aspects out of the override so their fields
        // own them; `specifics` keeps the remaining aspects untouched for a
        // lossless merge on save.
        const override = r.item_specifics_override ?? {};
        const { Department, Brand, Size, Color, ...rest } = override;
        return {
          id: r.id,
          itemId: r.inventory_item_id,
          title: r.listing_title ?? "",
          price: r.listing_price != null ? String(r.listing_price) : "",
          condition: r.ebay_condition ?? "",
          quantity: r.quantity != null ? String(r.quantity) : "1",
          bestOffer: r.best_offer_enabled ?? false,
          scheduledAt: isoToLocalInput(r.scheduled_publish_at),
          categoryId: r.platform_category_id ?? "",
          categoryPath: "",
          department: Department?.[0] ?? "",
          brand: Brand?.[0] ?? "",
          size: Size?.[0] ?? "",
          color: Color?.[0] ?? "",
          specifics: rest,
          validationBlockers: null,
          dirty: false,
        };
      }),
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
            // Re-merge the inline aspects back into the rest of the specifics. A
            // blank value drops the key (server re-derives it from the item's
            // column); null the whole column when nothing's left.
            const mergedSpecifics: Record<string, string[]> = { ...r.specifics };
            const setOrDrop = (key: string, value: string) => {
              const v = value.trim();
              if (v) mergedSpecifics[key] = [v];
              else delete mergedSpecifics[key];
            };
            setOrDrop("Department", r.department);
            setOrDrop("Brand", r.brand);
            setOrDrop("Size", r.size);
            setOrDrop("Color", r.color);
            const { error: upErr } = await supabase
              .from("listings")
              .update({
                listing_title: r.title.trim() || null,
                listing_price: Number.isFinite(price) ? price : 0,
                ebay_condition: r.condition || null,
                quantity: Number.isFinite(qty) && qty > 0 ? qty : 1,
                best_offer_enabled: r.bestOffer,
                scheduled_publish_at: localInputToIso(r.scheduledAt),
                platform_category_id: r.categoryId.trim() || null,
                item_specifics_override:
                  Object.keys(mergedSpecifics).length > 0 ? mergedSpecifics : null,
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

  // US-320: real publish-blocker checks via /listings/validate. Bounded
  // concurrency so a 100-row batch doesn't hammer the edge service. Save
  // dirty rows first so the server validates the latest edits.
  async function validateRows(targetRows: EditRow[]) {
    if (targetRows.length === 0) {
      toast.info("Select rows to validate (or save edits first).");
      return;
    }
    if (rows.some((r) => r.dirty)) {
      toast.warning("Save your edits before validating — the server reads from the listing row.");
      return;
    }
    setValidating(true);
    try {
      const CONCURRENCY = 4;
      let ok = 0;
      let blocked = 0;
      for (let i = 0; i < targetRows.length; i += CONCURRENCY) {
        const batch = targetRows.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map(async (row) => {
            try {
              const res = await edgeFetch("/api/flipdesk/ebay/listings/validate", {
                method: "POST",
                json: { inventory_item_id: row.itemId },
              });
              const json = await res.json().catch(() => ({}));
              const blockers = Array.isArray(json.blockers)
                ? (json.blockers as string[])
                : [];
              return { id: row.id, blockers };
            } catch (err) {
              return {
                id: row.id,
                blockers: [
                  err instanceof Error ? err.message : "Validation request failed.",
                ],
              };
            }
          }),
        );
        setRows((prev) =>
          prev.map((r) => {
            const hit = results.find((x) => x.id === r.id);
            return hit ? { ...r, validationBlockers: hit.blockers } : r;
          }),
        );
        for (const r of results) {
          if (r.blockers.length === 0) ok++;
          else blocked++;
        }
      }
      toast.success(`Validated ${targetRows.length} — ${ok} clean, ${blocked} blocked.`);
    } finally {
      setValidating(false);
    }
  }

  function rowIssues(r: EditRow): string[] {
    const issues: string[] = [];
    if (!r.title.trim()) issues.push("Title is empty");
    else if (r.title.length > TITLE_MAX) issues.push(`Title over ${TITLE_MAX} chars`);
    const price = Number.parseFloat(r.price);
    if (!Number.isFinite(price) || price <= 0) issues.push("Price not set");
    if (!r.condition) issues.push("No condition");
    if (!r.categoryId.trim()) issues.push("No category");
    // Server-side blockers from /listings/validate take precedence — they
    // reflect missing required aspects, etc., that the local heuristics can't see.
    if (r.validationBlockers && r.validationBlockers.length > 0) {
      issues.push(...r.validationBlockers);
    }
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
        <div className="flex items-end gap-1.5">
          <div>
            <label className="mb-1 block text-[10px] uppercase text-muted-foreground">
              Schedule publish
            </label>
            <Input
              type="datetime-local"
              value={bulkSchedule}
              onChange={(e) => setBulkSchedule(e.target.value)}
              className="h-8 w-52"
            />
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={!bulkSchedule}
            onClick={() => applyToTargets(() => ({ scheduledAt: bulkSchedule }))}
          >
            Apply
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => applyToTargets(() => ({ scheduledAt: "" }))}
          >
            Clear
          </Button>
        </div>
        <div className="flex items-end gap-1.5">
          <div>
            <label className="mb-1 block text-[10px] uppercase text-muted-foreground">
              eBay category
            </label>
            <CategorySearchControl
              categoryId={bulkCategory?.id ?? ""}
              categoryPath={bulkCategory?.path ?? ""}
              align="start"
              triggerClassName="w-56"
              onPick={(id, path) => setBulkCategory({ id, path })}
            />
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={!bulkCategory}
            onClick={() =>
              applyToTargets(() => ({
                categoryId: bulkCategory!.id,
                categoryPath: bulkCategory!.path,
              }))
            }
          >
            Apply
          </Button>
        </div>
        <div className="flex items-end gap-1.5">
          <div>
            <label className="mb-1 block text-[10px] uppercase text-muted-foreground">
              Department
            </label>
            <select
              value={bulkDepartment}
              onChange={(e) => setBulkDepartment(e.target.value)}
              className="h-8 w-36 rounded-md border border-input bg-transparent px-2 text-sm"
            >
              <option value="">Select…</option>
              {EBAY_DEPARTMENT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={!bulkDepartment}
            onClick={() => applyToTargets(() => ({ department: bulkDepartment }))}
          >
            Apply
          </Button>
        </div>
        <div className="flex items-end gap-1.5">
          <div>
            <label className="mb-1 block text-[10px] uppercase text-muted-foreground">
              Brand
            </label>
            <Input
              value={bulkBrand}
              onChange={(e) => setBulkBrand(e.target.value)}
              className="h-8 w-32"
              placeholder="e.g. Nike"
            />
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={!bulkBrand.trim()}
            onClick={() => applyToTargets(() => ({ brand: bulkBrand.trim() }))}
          >
            Apply
          </Button>
        </div>
        <div className="flex items-end gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            disabled={validating}
            onClick={() => {
              const target = selected.size > 0
                ? rows.filter((r) => selected.has(r.id))
                : rows;
              void validateRows(target);
            }}
          >
            {validating ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
            )}
            Validate {selected.size > 0 ? `(${selected.size})` : "all"}
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
              <th className="w-48 p-2">Category</th>
              <th className="w-36 p-2">Department</th>
              <th className="w-28 p-2">Brand</th>
              <th className="w-24 p-2">Size</th>
              <th className="w-28 p-2">Color</th>
              <th className="w-16 p-2">Qty</th>
              <th className="w-20 p-2">Best Offer</th>
              <th className="w-52 p-2">Schedule</th>
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
                      placeholder={itemAttrs[r.itemId]?.title ?? "Title"}
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
                    <CategorySearchControl
                      categoryId={r.categoryId}
                      categoryPath={r.categoryPath}
                      triggerClassName="w-full"
                      onPick={(id, path) =>
                        patchRow(r.id, { categoryId: id, categoryPath: path })
                      }
                      onClear={() =>
                        patchRow(r.id, { categoryId: "", categoryPath: "" })
                      }
                    />
                  </td>
                  <td className="p-2">
                    <select
                      value={r.department}
                      onChange={(e) => patchRow(r.id, { department: e.target.value })}
                      className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
                    >
                      <option value="">—</option>
                      {EBAY_DEPARTMENT_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="p-2">
                    <Input
                      value={r.brand}
                      onChange={(e) => patchRow(r.id, { brand: e.target.value })}
                      className="h-8"
                      placeholder={itemAttrs[r.itemId]?.brand || "—"}
                    />
                  </td>
                  <td className="p-2">
                    <Input
                      value={r.size}
                      onChange={(e) => patchRow(r.id, { size: e.target.value })}
                      className="h-8"
                      placeholder={itemAttrs[r.itemId]?.size || "—"}
                    />
                  </td>
                  <td className="p-2">
                    <Input
                      value={r.color}
                      onChange={(e) => patchRow(r.id, { color: e.target.value })}
                      className="h-8"
                      placeholder={itemAttrs[r.itemId]?.color || "—"}
                    />
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
                    <Input
                      type="datetime-local"
                      value={r.scheduledAt}
                      onChange={(e) => patchRow(r.id, { scheduledAt: e.target.value })}
                      className="h-8"
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
                <td colSpan={13} className="p-6 text-center text-sm text-muted-foreground">
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

// Small debounce so each keystroke across many rows doesn't hammer the Taxonomy
// suggest endpoint. The query only fires once the value settles for `ms`.
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

// Taxonomy-backed category search in a popover. Used both per-row and in the
// bulk-apply toolbar. Renders the picked leaf's path (or its id when the path
// isn't known yet) on the trigger; searching hits eBay's live category tree via
// useEbayCategorySuggest, so every eBay category is reachable with nothing
// hardcoded. The popover content is portaled, so the table's horizontal scroll
// container never clips the results.
function CategorySearchControl({
  categoryId,
  categoryPath,
  onPick,
  onClear,
  triggerClassName,
  align = "center",
}: {
  categoryId: string;
  categoryPath: string;
  onPick: (id: string, path: string) => void;
  onClear?: () => void;
  triggerClassName?: string;
  align?: "start" | "center" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query.trim(), 250);
  const suggest = useEbayCategorySuggest(debounced);
  const results = suggest.data ?? [];

  const label = categoryPath || (categoryId ? `Category #${categoryId}` : "");

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-8 items-center gap-1.5 truncate rounded-md border border-input bg-transparent px-2 text-left text-xs",
            !label && "text-muted-foreground",
            triggerClassName,
          )}
          title={label || "Search eBay categories"}
        >
          <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{label || "Search category…"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-80 p-0">
        <div className="border-b p-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. women's blouse, men's blazer"
              className="h-8 pl-7 text-xs"
            />
            {suggest.isFetching && (
              <Loader2 className="absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
            )}
          </div>
        </div>
        <div className="max-h-64 overflow-y-auto">
          {debounced.length < 2 ? (
            <div className="p-3 text-xs text-muted-foreground">
              Type at least 2 characters to search eBay categories.
            </div>
          ) : results.length === 0 && !suggest.isFetching ? (
            <div className="p-3 text-xs text-muted-foreground">
              No matches. Try a different keyword.
            </div>
          ) : (
            results.map((s) => (
              <button
                key={s.categoryId}
                type="button"
                onClick={() => {
                  onPick(s.categoryId, s.categoryTreePath);
                  setOpen(false);
                  setQuery("");
                }}
                className="block w-full border-b px-3 py-2 text-left text-xs last:border-b-0 hover:bg-muted/50"
              >
                <div className="font-medium">{s.categoryName}</div>
                <div className="text-muted-foreground">{s.categoryTreePath}</div>
              </button>
            ))
          )}
        </div>
        {categoryId && onClear && (
          <div className="border-t p-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-full text-xs"
              onClick={() => {
                onClear();
                setOpen(false);
                setQuery("");
              }}
            >
              Clear category
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
