import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Loader2,
  ArrowLeft,
  Trash2,
  PackageCheck,
  Boxes,
} from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SourcedBySelect } from "@/components/flipdesk/sourced-by-select";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { VirtualList } from "@/components/flipdesk/virtual-list";
import { supabase } from "@/lib/supabase";
import { useAuthStore } from "@/stores/auth-store";
import { useWorkspace } from "@/hooks/use-workspace";
import { useSources } from "@/hooks/use-sources";
import { ITEM_CATEGORIES } from "@/lib/constants";
import { todayLocalDate } from "@/lib/local-date";
import type { InventoryItemInsert, ItemCategory } from "@/types/database";

const STORAGE_KEY = "flipdesk-bulk-intake-session";

interface BulkItem {
  id: string;
  title: string;
  sku: string;
  brand: string;
  style: string;
  size: string;
  color: string;
  category: ItemCategory | "";
  description: string;
  notes: string;
}

interface BulkSession {
  sourceId: string; // "" | "__new" | uuid
  sourceNew: string;
  sourcedBy: string;
  container: string;
  purchaseDate: string;
  haulTotal: string;
  items: BulkItem[];
  draft: Omit<BulkItem, "id">;
}

const EMPTY_DRAFT: Omit<BulkItem, "id"> = {
  title: "",
  sku: "",
  brand: "",
  style: "",
  size: "",
  color: "",
  category: "",
  description: "",
  notes: "",
};

function freshSession(): BulkSession {
  return {
    sourceId: "",
    sourceNew: "",
    sourcedBy: "",
    container: "",
    purchaseDate: todayLocalDate(),
    haulTotal: "",
    items: [],
    draft: { ...EMPTY_DRAFT },
  };
}

function loadSession(): BulkSession {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return freshSession();
    const parsed = JSON.parse(raw) as Partial<BulkSession>;
    return { ...freshSession(), ...parsed };
  } catch {
    return freshSession();
  }
}

function trimOrNull(v: string): string | null {
  const t = v.trim();
  return t === "" ? null : t;
}

export function BulkIntake() {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const { workspaceOwnerId, can } = useWorkspace();
  const { data: sources = [] } = useSources();
  const [session, setSession] = useState<BulkSession>(loadSession);
  const [finalizing, setFinalizing] = useState(false);

  // Persist the whole session so a refresh mid-haul loses nothing.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } catch {
      /* storage full / unavailable — non-fatal */
    }
  }, [session]);

  const itemCount = session.items.length;
  const haulTotal = Number(session.haulTotal);
  const perItem =
    itemCount > 0 && Number.isFinite(haulTotal) && haulTotal > 0
      ? haulTotal / itemCount
      : 0;

  function patchDraft<K extends keyof Omit<BulkItem, "id">>(
    k: K,
    v: BulkItem[K],
  ) {
    setSession((s) => ({ ...s, draft: { ...s.draft, [k]: v } }));
  }

  function addToSession() {
    if (!session.draft.title.trim()) {
      toast.error("Item title is required.");
      return;
    }
    setSession((s) => ({
      ...s,
      items: [...s.items, { id: crypto.randomUUID(), ...s.draft }],
      // Clear the item-unique fields; keep size/color/category since a haul
      // lot is often the same kind of item.
      draft: {
        ...s.draft,
        title: "",
        sku: "",
        brand: "",
        style: "",
        description: "",
        notes: "",
      },
    }));
  }

  function removeItem(id: string) {
    setSession((s) => ({ ...s, items: s.items.filter((i) => i.id !== id) }));
  }

  async function discardSession() {
    if (
      !(await confirm({
        title: "Discard this haul session?",
        description: "Captured items in this session are lost. This can't be undone.",
        confirmLabel: "Discard haul",
        destructive: true,
      }))
    )
      return;
    setSession(freshSession());
    localStorage.removeItem(STORAGE_KEY);
  }

  async function endSession() {
    if (!user || !workspaceOwnerId) {
      toast.error("You must be signed in.");
      return;
    }
    if (!can("manage_inventory")) {
      toast.error("You don't have permission to add inventory in this workspace.");
      return;
    }
    if (itemCount === 0) {
      toast.error("Add at least one item before finishing.");
      return;
    }
    if (session.sourceId === "__new" && !session.sourceNew.trim()) {
      toast.error("Enter a name for the new source.");
      return;
    }

    setFinalizing(true);
    try {
      // Resolve the shared source once for the whole haul.
      let sourceId: string | null = null;
      if (session.sourceId === "__new" && session.sourceNew.trim()) {
        const supabaseAny = supabase as unknown as {
          rpc: (
            fn: string,
            args: Record<string, unknown>,
          ) => Promise<{ data: string | null; error: Error | null }>;
        };
        const { data, error } = await supabaseAny.rpc("get_or_create_source", {
          p_user_id: workspaceOwnerId,
          p_name: session.sourceNew.trim(),
          p_source_type: "other",
        });
        if (error) throw error;
        sourceId = data;
      } else if (session.sourceId && session.sourceId !== "__none") {
        sourceId = session.sourceId;
      }

      // Split the haul cost evenly across the captured items.
      const perItemCost =
        Number.isFinite(haulTotal) && haulTotal > 0
          ? Math.round((haulTotal / itemCount) * 100) / 100
          : null;

      const rows: InventoryItemInsert[] = session.items.map((it) => ({
        user_id: workspaceOwnerId,
        title: it.title.trim(),
        sku: trimOrNull(it.sku),
        brand: trimOrNull(it.brand),
        style: trimOrNull(it.style),
        size: trimOrNull(it.size),
        color: trimOrNull(it.color),
        item_category: it.category === "" ? null : it.category,
        description: trimOrNull(it.description),
        condition_notes: trimOrNull(it.notes),
        container: trimOrNull(session.container),
        sourced_by: trimOrNull(session.sourcedBy),
        source_id: sourceId,
        acquired_date: session.purchaseDate || null,
        acquired_price: perItemCost,
        status: "cataloged",
      }));

      const { error } = await supabase
        .from("inventory_items")
        .insert(rows as never);
      if (error) throw error;

      await qc.invalidateQueries({ queryKey: ["items_full"] });
      await qc.invalidateQueries({ queryKey: ["sources"] });
      localStorage.removeItem(STORAGE_KEY);
      setSession(freshSession());
      toast.success(
        `Haul finalized — ${itemCount} item${itemCount === 1 ? "" : "s"} cataloged.`,
      );
      navigate("/dashboard/flipdesk/inventory?mode=kanban");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Finalize failed: ${msg}`);
    } finally {
      setFinalizing(false);
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
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-navy text-white">
            <Boxes className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Bulk haul intake
            </h1>
            <p className="text-sm text-muted-foreground">
              Capture a whole haul fast. Set the shared source and total cost
              once, then add items — cost is split evenly when you finish.
            </p>
          </div>
        </div>
      </div>

      <div className="flex justify-end">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/dashboard/flipdesk/intake">Switch to single item</Link>
        </Button>
      </div>

      {/* Shared haul header */}
      <Card>
        <CardHeader>
          <CardTitle>Haul details</CardTitle>
          <CardDescription>
            Applied to every item in this session.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="bi-source">Source</Label>
            <Select
              value={session.sourceId || "__none"}
              onValueChange={(v) =>
                setSession((s) => ({
                  ...s,
                  sourceId: v === "__none" ? "" : v,
                }))
              }
            >
              <SelectTrigger id="bi-source">
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
            {session.sourceId === "__new" && (
              <Input
                className="mt-2"
                aria-label="New source name"
                placeholder="New source name"
                value={session.sourceNew}
                onChange={(e) =>
                  setSession((s) => ({ ...s, sourceNew: e.target.value }))
                }
              />
            )}
          </div>
          <SourcedBySelect
            id="bi-sourced-by"
            className="space-y-1"
            value={session.sourcedBy}
            onChange={(v) => setSession((s) => ({ ...s, sourcedBy: v }))}
          />
          <div className="space-y-1">
            <Label htmlFor="bi-container-bin">Container / Bin</Label>
            <Input id="bi-container-bin"
              value={session.container}
              onChange={(e) =>
                setSession((s) => ({ ...s, container: e.target.value }))
              }
              placeholder="e.g. A1"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bi-purchase-date">Purchase date</Label>
            <Input id="bi-purchase-date"
              type="date"
              value={session.purchaseDate}
              onChange={(e) =>
                setSession((s) => ({ ...s, purchaseDate: e.target.value }))
              }
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bi-haul-total-cost">Haul total cost</Label>
            <Input id="bi-haul-total-cost"
              type="number"
              step="0.01"
              value={session.haulTotal}
              onChange={(e) =>
                setSession((s) => ({ ...s, haulTotal: e.target.value }))
              }
              placeholder="0.00"
            />
          </div>
          <div className="flex flex-col justify-end space-y-1">
            <Label className="text-muted-foreground">Cost per item</Label>
            <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3 font-mono text-sm tabular-nums">
              {perItem > 0 ? `$${perItem.toFixed(2)}` : "—"}
              <span className="ml-2 text-xs text-muted-foreground">
                ({itemCount} item{itemCount === 1 ? "" : "s"})
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Add item */}
      <Card>
        <CardHeader>
          <CardTitle>Add item</CardTitle>
          <CardDescription>
            Only title is required. Size, color and category carry over to the
            next item so a lot of similar pieces goes fast.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="bi-title">Title *</Label>
              <Input id="bi-title"
                value={session.draft.title}
                onChange={(e) => patchDraft("title", e.target.value)}
                placeholder="e.g. Nike Dri-FIT Tee"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addToSession();
                  }
                }}
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bi-sku-item">SKU / Item #</Label>
              <Input id="bi-sku-item"
                value={session.draft.sku}
                onChange={(e) => patchDraft("sku", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bi-brand">Brand</Label>
              <Input id="bi-brand"
                value={session.draft.brand}
                onChange={(e) => patchDraft("brand", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bi-style">Style</Label>
              <Input id="bi-style"
                value={session.draft.style}
                onChange={(e) => patchDraft("style", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bi-size">Size</Label>
              <Input id="bi-size"
                value={session.draft.size}
                onChange={(e) => patchDraft("size", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bi-color">Color</Label>
              <Input id="bi-color"
                value={session.draft.color}
                onChange={(e) => patchDraft("color", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bi-category">Category</Label>
              <Select
                value={session.draft.category || "__none"}
                onValueChange={(v) =>
                  patchDraft(
                    "category",
                    v === "__none" ? "" : (v as ItemCategory),
                  )
                }
              >
                <SelectTrigger id="bi-category">
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
          </div>
          <div className="space-y-1">
            <Label htmlFor="bi-notes">Notes</Label>
            <Textarea id="bi-notes"
              rows={2}
              value={session.draft.notes}
              onChange={(e) => patchDraft("notes", e.target.value)}
              placeholder="Defects, condition, source context…"
            />
          </div>
          <Button onClick={addToSession}>
            <Plus className="mr-2 h-4 w-4" />
            Add to session
          </Button>
        </CardContent>
      </Card>

      {/* Session items strip */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Session items ({itemCount})</CardTitle>
              <CardDescription>
                Nothing is saved until you finish the haul.
              </CardDescription>
            </div>
            {itemCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={discardSession}
                disabled={finalizing}
              >
                Discard
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {itemCount === 0 ? (
            <div className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground">
              No items captured yet.
            </div>
          ) : (
            // US-416: virtualized so a large haul (1k+ items) stays smooth.
            <VirtualList
              items={session.items}
              getKey={(it) => it.id}
              estimateSize={60}
              gap={6}
              className="max-h-[60dvh]"
              renderItem={(it, i) => (
                <div className="flex items-center gap-3 rounded-md border p-2.5">
                  <span className="w-6 flex-shrink-0 text-center font-mono text-xs text-muted-foreground">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {it.title}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {[it.brand, it.style, it.size, it.color]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                    </div>
                  </div>
                  {perItem > 0 && (
                    <span className="flex-shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                      ${perItem.toFixed(2)}
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 flex-shrink-0 text-destructive"
                    onClick={() => removeItem(it.id)}
                    disabled={finalizing}
                    aria-label={`Remove ${it.title}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            />
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-end gap-2">
        <Button
          onClick={endSession}
          disabled={finalizing || itemCount === 0}
        >
          {finalizing ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <PackageCheck className="mr-2 h-4 w-4" />
          )}
          End session — catalog {itemCount} item{itemCount === 1 ? "" : "s"}
        </Button>
      </div>
    </div>
  );
}
