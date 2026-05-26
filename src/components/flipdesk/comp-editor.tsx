import { useState } from "react";
import { Plus, Trash2, ExternalLink, Wand2, ClipboardPaste } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { computeStats, ebaySoldSearchUrl } from "@/lib/comps";
import type { ItemComp } from "@/types/database";

interface Props {
  comps: ItemComp[];
  onChange: (next: ItemComp[]) => void;
  brand?: string | null;
  style?: string | null;
  size?: string | null;
  title?: string | null;
  onSuggestTarget?: (price: number) => void;
}

function emptyComp(): ItemComp {
  return { price: 0 };
}

export function CompEditor({
  comps,
  onChange,
  brand,
  style,
  size,
  title,
  onSuggestTarget,
}: Props) {
  const stats = computeStats(comps);
  const [bulkText, setBulkText] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);

  function update(i: number, patch: Partial<ItemComp>) {
    const next = comps.slice();
    const current = next[i];
    if (!current) return;
    next[i] = { ...current, ...patch };
    onChange(next);
  }

  function remove(i: number) {
    const next = comps.slice();
    next.splice(i, 1);
    onChange(next);
  }

  function add() {
    onChange([...comps, emptyComp()]);
  }

  // Parse a line like "$25.99 ebay.com/itm/123 - good condition" into a comp.
  function parseBulkLine(line: string): ItemComp | null {
    const t = line.trim();
    if (!t) return null;
    const priceMatch = t.match(/\$?\s*(\d+(?:\.\d+)?)/);
    if (!priceMatch) return null;
    const price = Number(priceMatch[1]);
    if (!Number.isFinite(price)) return null;
    const urlMatch = t.match(/https?:\/\/\S+/);
    const url = urlMatch ? urlMatch[0] : undefined;
    // Notes = the rest of the line stripped of price and URL.
    let notes = t.replace(priceMatch[0], "").trim();
    if (url) notes = notes.replace(url, "").trim();
    notes = notes.replace(/^[-–—:|]\s*/, "").replace(/\s+/g, " ").trim();
    return {
      price,
      ...(url ? { url } : {}),
      ...(notes ? { notes } : {}),
    };
  }

  function applyBulk() {
    const lines = bulkText.split(/\r?\n/);
    const parsed: ItemComp[] = [];
    for (const line of lines) {
      const c = parseBulkLine(line);
      if (c) parsed.push(c);
    }
    if (parsed.length > 0) {
      onChange([...comps, ...parsed]);
      setBulkText("");
      setBulkOpen(false);
    }
  }

  // Reads the clipboard, runs every line through parseBulkLine, and appends
  // anything with a price. The same logic as bulk paste, one click.
  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        toast.error("Clipboard is empty.");
        return;
      }
      const lines = text.split(/\r?\n/);
      const parsed: ItemComp[] = [];
      for (const line of lines) {
        const c = parseBulkLine(line);
        if (c) parsed.push(c);
      }
      if (parsed.length === 0) {
        toast.error(
          "Couldn't find a price in the clipboard. Try pasting like '$24.99 https://… notes'.",
        );
        return;
      }
      onChange([...comps, ...parsed]);
      toast.success(
        `Added ${parsed.length} comp${parsed.length === 1 ? "" : "s"} from clipboard.`,
      );
    } catch {
      toast.error(
        "Browser blocked clipboard access. Use Bulk paste instead.",
      );
    }
  }

  const searchUrl = ebaySoldSearchUrl({ brand, style, size, title });
  const fmt = (n: number | null) =>
    n == null ? "—" : `$${n.toFixed(2)}`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline">
            {stats.count} comp{stats.count === 1 ? "" : "s"}
          </Badge>
          {stats.avg != null && (
            <Badge variant="secondary" className="font-mono tabular-nums">
              avg {fmt(stats.avg)}
            </Badge>
          )}
          {stats.median != null && (
            <Badge variant="secondary" className="font-mono tabular-nums">
              median {fmt(stats.median)}
            </Badge>
          )}
          {stats.min != null && stats.max != null && stats.min !== stats.max && (
            <Badge variant="outline" className="font-mono tabular-nums">
              {fmt(stats.min)} – {fmt(stats.max)}
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <a href={searchUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="mr-2 h-3 w-3" />
              Search eBay sold
            </a>
          </Button>
          {onSuggestTarget && stats.median != null && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onSuggestTarget(Number(stats.median!.toFixed(2)))}
            >
              <Wand2 className="mr-2 h-3 w-3" />
              Use {fmt(stats.median)} as target
            </Button>
          )}
        </div>
      </div>

      {comps.length === 0 ? (
        <div className="rounded-md border border-dashed py-8 text-center text-xs text-muted-foreground">
          No comps yet. Add manually or paste from clipboard.
        </div>
      ) : (
        <div className="space-y-2">
          {comps.map((c, i) => (
            <div
              key={i}
              className={cn(
                // Stacks at narrow widths, snaps to 12-col grid at sm+
                // so the price + date + notes + trash row fits comfortably
                // inside narrower modals on tablet portraits.
                "flex flex-col gap-2 rounded-md border p-2 sm:grid sm:grid-cols-12",
                !c.price && "bg-amber-50/40 dark:bg-amber-950/20",
              )}
            >
              <div className="space-y-1 sm:col-span-3">
                <Label className="text-[10px] uppercase text-muted-foreground">
                  Price
                </Label>
                <Input
                  type="number"
                  step="0.01"
                  value={c.price === 0 ? "" : String(c.price)}
                  onChange={(e) =>
                    update(i, { price: Number(e.target.value) || 0 })
                  }
                  className="h-8 font-mono"
                  placeholder="0.00"
                />
              </div>
              <div className="space-y-1 sm:col-span-3">
                <Label className="text-[10px] uppercase text-muted-foreground">
                  Date
                </Label>
                <Input
                  type="date"
                  value={c.sold_date ?? ""}
                  onChange={(e) =>
                    update(i, { sold_date: e.target.value || undefined })
                  }
                  className="h-8"
                />
              </div>
              <div className="space-y-1 sm:col-span-5">
                <Label className="text-[10px] uppercase text-muted-foreground">
                  Notes / URL
                </Label>
                <Input
                  value={c.notes ?? c.url ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    const isUrl = /^https?:\/\//i.test(v);
                    update(i, isUrl ? { url: v, notes: undefined } : { notes: v });
                  }}
                  className="h-8"
                  placeholder="Condition note or sold-listing URL"
                />
              </div>
              <div className="flex items-end justify-end sm:col-span-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-destructive"
                  onClick={() => remove(i)}
                  aria-label="Remove comp"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              {c.url && (
                <div className="col-span-12 -mt-1 truncate text-[10px]">
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand-red underline"
                  >
                    {c.url}
                  </a>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={add}>
          <Plus className="mr-2 h-3 w-3" />
          Add comp
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void pasteFromClipboard()}
        >
          <ClipboardPaste className="mr-2 h-3 w-3" />
          Paste from clipboard
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setBulkOpen((o) => !o)}
        >
          {bulkOpen ? "Cancel bulk" : "Bulk paste"}
        </Button>
      </div>

      {bulkOpen && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <Label className="text-xs">
            Paste one comp per line (price + optional URL + notes)
          </Label>
          <textarea
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            rows={5}
            className="w-full rounded-md border bg-background p-2 font-mono text-xs"
            placeholder={"$24.99 - good condition, light wear\n$32 https://www.ebay.com/itm/123 NWT\n28.50"}
          />
          <div className="flex justify-end">
            <Button size="sm" onClick={applyBulk} disabled={!bulkText.trim()}>
              Add lines
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
