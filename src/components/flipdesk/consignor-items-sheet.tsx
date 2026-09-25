import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { edgeFetch } from "@/lib/edge-fetch";
import { useAuthStore } from "@/stores/auth-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { LoadingRegion, SkeletonRows } from "@/components/ui/skeletons";
import { CONSIGNOR_MONEY_ADMIN_ONLY } from "@/lib/workspace-permissions";

// C15: attach inventory to a consignor from the web. Before this nothing on
// the web wrote inventory_items.consignor_id, so the Items, Gross and Owed
// columns and the auto-payout engine had no input.

interface ConsignedItem {
  id: string;
  title: string;
  brand: string | null;
  sku: string | null;
  status: string;
}

async function getJson<T>(path: string, fallback: string): Promise<T> {
  const res = await edgeFetch(path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? fallback);
  return body as T;
}

function itemLabel(i: ConsignedItem): string {
  return [i.title, i.brand, i.sku].filter(Boolean).join(" · ");
}

export function ConsignorItemsSheet({
  consignor,
  canManageMoney,
  onClose,
  onChanged,
}: {
  consignor: { id: string; name: string } | null;
  canManageMoney: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const ownerId = useAuthStore((s) => s.activeWorkspaceOwnerId ?? s.user?.id);
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSearch("");
    setTerm("");
    setPicked(new Set());
  }, [consignor?.id]);

  // Debounce the picker search so typing does not fire a request per key.
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const open = !!consignor;
  const assigned = useQuery({
    queryKey: ["consignor-items", ownerId, consignor?.id],
    enabled: open && !!ownerId,
    queryFn: () =>
      getJson<{ items: ConsignedItem[] }>(
        `/api/flipdesk/consignment/consignors/${consignor!.id}/items`,
        "Couldn't load this consignor's items.",
      ).then((b) => b.items ?? []),
  });
  const available = useQuery({
    queryKey: ["consignor-unassigned-items", ownerId, term],
    enabled: open && !!ownerId && canManageMoney,
    queryFn: () =>
      getJson<{ items: ConsignedItem[] }>(
        `/api/flipdesk/consignment/unassigned-items${term ? `?q=${encodeURIComponent(term)}` : ""}`,
        "Couldn't load your items.",
      ).then((b) => b.items ?? []),
  });

  async function change(ids: string[], unassign: boolean) {
    if (!consignor || ids.length === 0) return;
    setBusy(true);
    try {
      const res = await edgeFetch(
        `/api/flipdesk/consignment/consignors/${consignor.id}/items`,
        { method: "POST", json: { item_ids: ids, unassign } },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Couldn't update those items.");
      const n = Number(body.updated ?? 0);
      if (unassign) {
        toast.success(`Removed ${n} item${n === 1 ? "" : "s"} from ${consignor.name}.`);
      } else if (n < ids.length) {
        toast.warning(
          `Added ${n} of ${ids.length}. The rest already belong to a consignor.`,
        );
      } else {
        toast.success(`Added ${n} item${n === 1 ? "" : "s"} to ${consignor.name}.`);
      }
      setPicked(new Set());
      void qc.invalidateQueries({ queryKey: ["consignor-items"] });
      void qc.invalidateQueries({ queryKey: ["consignor-unassigned-items"] });
      onChanged();
    } catch (err) {
      toastError(err, "Couldn't update those items");
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string, on: boolean) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  const items = assigned.data ?? [];

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Items from {consignor?.name}</SheetTitle>
          <SheetDescription>
            Items you attach here count toward this consignor's sales, split
            and payouts. The split is saved on each item when you add it.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-6 px-4 pb-6">
          <section className="space-y-2" aria-labelledby="consigned-items-heading">
            <h3 id="consigned-items-heading" className="text-sm font-medium">
              Attached ({items.length})
            </h3>
            {assigned.isLoading ? (
              <LoadingRegion label="Loading items">
                <SkeletonRows rows={3} />
              </LoadingRegion>
            ) : assigned.error ? (
              <div className="space-y-2 text-sm">
                <p className="text-destructive">{(assigned.error as Error).message}</p>
                <Button variant="outline" size="sm" onClick={() => void assigned.refetch()}>
                  Try again
                </Button>
              </div>
            ) : items.length === 0 ? (
              <p className="text-sm text-muted-foreground">No items attached yet.</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {items.map((i) => (
                  <li key={i.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">{itemLabel(i)}</span>
                    <Badge variant="outline">{i.status}</Badge>
                    {canManageMoney && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9"
                        disabled={busy}
                        onClick={() => void change([i.id], true)}
                        aria-label={`Remove ${i.title} from ${consignor?.name ?? "this consignor"}`}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {canManageMoney ? (
            <section className="space-y-2" aria-labelledby="add-items-heading">
              <h3 id="add-items-heading" className="text-sm font-medium">
                Add items
              </h3>
              <Input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search your unsold items by title"
                aria-label="Search your unsold items"
              />
              {available.isLoading ? (
                <LoadingRegion label="Loading your items">
                  <SkeletonRows rows={3} />
                </LoadingRegion>
              ) : available.error ? (
                <p className="text-sm text-destructive">
                  {(available.error as Error).message}
                </p>
              ) : (available.data ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {term
                    ? "No unsold, unassigned items match that."
                    : "Every unsold item already belongs to a consignor, or you have none yet."}
                </p>
              ) : (
                <ul className="max-h-72 divide-y overflow-y-auto rounded-md border">
                  {(available.data ?? []).map((i) => (
                    <li key={i.id}>
                      <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                        <Checkbox
                          checked={picked.has(i.id)}
                          onCheckedChange={(v) => toggle(i.id, v === true)}
                        />
                        <span className="min-w-0 flex-1 truncate">{itemLabel(i)}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <Button
                className="w-full sm:w-auto"
                disabled={busy || picked.size === 0}
                onClick={() => void change([...picked], false)}
              >
                {busy ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="mr-2 h-4 w-4" />
                )}
                Add {picked.size || ""} item{picked.size === 1 ? "" : "s"}
              </Button>
            </section>
          ) : (
            <p className="text-sm text-muted-foreground">{CONSIGNOR_MONEY_ADMIN_ONLY}</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
