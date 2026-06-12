import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Loader2, Check, GitCompare, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  useApplyReconcile,
  useLinkToExisting,
  useReconcileDiff,
  type ReconcileFieldDiff,
} from "@/hooks/use-autolister";

interface Props {
  itemId: string;
  // Optional label (e.g. the item title) shown in the header.
  title?: string;
}

// Field-by-field reconciliation between the seller's imported inventory record
// (Original) and the AutoLister AI draft (AI). The seller picks the winner per
// field; applying writes the merged result to BOTH the listing draft and the
// inventory record. Lazy: the diff only loads once expanded.
export function ReconcilePanel({ itemId, title }: Props) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  // The item we're actually reconciling. Starts as this AutoLister item, but a
  // successful "link to existing SKU" re-points everything onto the target and
  // switches us to it.
  const [effectiveItemId, setEffectiveItemId] = useState(itemId);
  const diff = useReconcileDiff(effectiveItemId, open);
  const apply = useApplyReconcile();
  const link = useLinkToExisting();
  const [linkSku, setLinkSku] = useState("");

  async function handleLink() {
    const sku = linkSku.trim();
    if (!sku) return;
    try {
      const res = await link.mutateAsync({ sourceItemId: itemId, targetSku: sku });
      setEffectiveItemId(res.target_item_id);
      setLinkSku("");
      await qc.invalidateQueries({ queryKey: ["items_full"] });
      toast.success(`Linked to #${sku}. Now pick which fields to keep.`);
    } catch {
      /* hook surfaces the error toast */
    }
  }

  // Per-field winning side, seeded from the server's suggestion once loaded.
  const [choices, setChoices] = useState<Record<string, "original" | "ai">>({});
  useEffect(() => {
    if (!diff.data) return;
    const seed: Record<string, "original" | "ai"> = {};
    for (const f of diff.data.fields) seed[f.key] = f.suggested;
    setChoices(seed);
  }, [diff.data]);

  const fields = diff.data?.fields ?? [];
  const conflicts = diff.data?.conflicts ?? 0;

  const handleApply = async () => {
    try {
      await apply.mutateAsync({ itemId: effectiveItemId, choices });
      toast.success("Merged fields saved to the draft and your inventory.");
    } catch {
      /* hook surfaces the error toast */
    }
  };

  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/40"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        )}
        <GitCompare className="h-4 w-4 text-brand-navy dark:text-foreground" />
        <span className="font-medium">Reconcile with inventory</span>
        {title && (
          <span className="truncate text-muted-foreground">— {title}</span>
        )}
        {open && conflicts > 0 && (
          <Badge variant="secondary" className="ml-auto">
            {conflicts} {conflicts === 1 ? "conflict" : "conflicts"}
          </Badge>
        )}
      </button>

      {open && (
        <div className="border-t p-3">
          {diff.isLoading ? (
            <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Comparing your record with the AI draft…
            </div>
          ) : diff.isError ? (
            <p className="text-sm text-destructive">
              {(diff.error as Error).message}
            </p>
          ) : !diff.data?.has_original ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                This item isn&apos;t linked to an existing inventory record. If
                you already have it in inventory, enter its SKU to tie them
                together — the photos and AI draft move onto that item and you
                can reconcile its fields.
              </p>
              <div className="flex items-center gap-2">
                <Input
                  value={linkSku}
                  onChange={(e) => setLinkSku(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleLink();
                  }}
                  placeholder="Existing SKU (e.g. 695)"
                  className="h-9 max-w-[12rem]"
                />
                <Button
                  size="sm"
                  onClick={handleLink}
                  disabled={!linkSku.trim() || link.isPending}
                >
                  {link.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Link2 className="mr-2 h-4 w-4" />
                  )}
                  Link to existing item
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="mb-2 grid grid-cols-[5.5rem_1fr_1fr] gap-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                <span>Field</span>
                <span>Original (sheet)</span>
                <span>AI version</span>
              </div>
              <div className="space-y-1.5">
                {fields.map((f) => (
                  <FieldRow
                    key={f.key}
                    field={f}
                    choice={choices[f.key] ?? f.suggested}
                    onPick={(side) =>
                      setChoices((prev) => ({ ...prev, [f.key]: side }))
                    }
                  />
                ))}
              </div>
              <div className="mt-3 flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  Picks save to the draft and your inventory record.
                </p>
                <Button size="sm" onClick={handleApply} disabled={apply.isPending}>
                  {apply.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="mr-2 h-4 w-4" />
                  )}
                  Save merged
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function FieldRow({
  field,
  choice,
  onPick,
}: {
  field: ReconcileFieldDiff;
  choice: "original" | "ai";
  onPick: (side: "original" | "ai") => void;
}) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr_1fr] items-stretch gap-2">
      <div className="flex items-center text-xs font-medium">
        {field.label}
        {field.differs && (
          <span
            className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-500"
            title="The two versions differ"
          />
        )}
      </div>
      <ValueCell
        value={field.original}
        selected={choice === "original"}
        onClick={() => onPick("original")}
      />
      <ValueCell
        value={field.ai}
        selected={choice === "ai"}
        onClick={() => onPick("ai")}
      />
    </div>
  );
}

function ValueCell({
  value,
  selected,
  onClick,
}: {
  value: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex min-h-8 items-start gap-1.5 rounded-md border px-2 py-1.5 text-left text-xs transition-colors",
        selected
          ? "border-brand-navy bg-brand-navy/5 ring-1 ring-brand-navy"
          : "border-input hover:bg-muted/50",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border",
          selected ? "border-brand-navy bg-brand-navy text-white" : "border-muted-foreground/40",
        )}
      >
        {selected && <Check className="h-2.5 w-2.5" />}
      </span>
      <span className="break-words">
        {value || <span className="italic text-muted-foreground">empty</span>}
      </span>
    </button>
  );
}
