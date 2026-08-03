import { useId, useMemo, useState } from "react";
import { Loader2, Table2, Wand2 } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useClearSheetMap,
  useGoogleConnection,
  useSaveSheetMap,
  useSheetTabs,
  useSuggestSheetMap,
  type MappableField,
  type SheetMapConfig,
  type SheetMapSuggestion,
} from "@/hooks/use-google-sheets";

const UNMAPPED = "__skip";

// Lets a seller sync their OWN spreadsheet tab (matched by SKU) instead of the
// generated Inventory/Listings/… tabs: pick a tab → auto-detect columns →
// review the header→field mapping → save. Two-way for inventory fields;
// listing/sale columns are a read-only mirror.
export function SheetMapCard() {
  const { data: connection } = useGoogleConnection();
  const hasSheet = !!connection?.has_sheet;
  const activeMap = connection?.sheet_map ?? null;

  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState("");
  // US-2335: id for the tab picker; the per-column selects are named from
  // their own header.
  const tabId = useId();
  const [suggestion, setSuggestion] = useState<SheetMapSuggestion | null>(null);
  // header → chosen field key ("" / UNMAPPED = don't sync).
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [createFromSheet, setCreateFromSheet] = useState(true);

  const tabs = useSheetTabs(editing);
  const suggest = useSuggestSheetMap();
  const save = useSaveSheetMap();
  const clear = useClearSheetMap();

  const fieldsByKey = useMemo(() => {
    const m = new Map<string, MappableField>();
    for (const f of suggestion?.fields ?? []) m.set(f.field, f);
    return m;
  }, [suggestion]);

  function startEditing() {
    setEditing(true);
    setSuggestion(null);
    setChoices({});
    setTab(activeMap?.tab ?? "");
  }

  async function detect() {
    if (!tab) {
      toast.error("Pick a tab first.");
      return;
    }
    const result = await suggest.mutateAsync({ tab });
    setSuggestion(result);
    setCreateFromSheet(result.map.createFromSheet);
    // Seed choices from the auto-suggested map (or the active map if same tab).
    const seed: Record<string, string> = {};
    const source =
      activeMap && activeMap.tab === tab ? activeMap.columns : result.map.columns;
    for (const h of result.headers) {
      const col = source.find((c) => c.header === h);
      seed[h] = col ? col.field : UNMAPPED;
    }
    setChoices(seed);
  }

  function buildMap(): SheetMapConfig | { error: string } {
    if (!suggestion) return { error: "Detect columns first." };
    const columns: SheetMapConfig["columns"] = [];
    let keyHeader = "";
    for (const header of suggestion.headers) {
      const fieldKey = choices[header];
      if (!fieldKey || fieldKey === UNMAPPED) continue;
      const f = fieldsByKey.get(fieldKey);
      if (!f) continue;
      if (f.role === "key") keyHeader = header;
      columns.push({
        header,
        field: f.field,
        table: f.table,
        ...(f.role === "key" ? { role: "key" as const } : {}),
        ...(f.writable && f.table === "inventory_items" ? { writable: true } : {}),
        kind: f.kind,
        ...(f.enumValues ? { enumValues: f.enumValues } : {}),
      });
    }
    if (!keyHeader) {
      return { error: "Map one column to “SKU (match key)” — it identifies each item." };
    }
    return { tab: suggestion.tab, keyColumn: keyHeader, createFromSheet, columns };
  }

  async function onSave() {
    const built = buildMap();
    if ("error" in built) {
      toast.error(built.error);
      return;
    }
    await save.mutateAsync({ map: built });
    setEditing(false);
  }

  if (!hasSheet) return null; // needs a connected spreadsheet first

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Table2 className="h-5 w-5 text-primary" />
          Sync your own sheet
        </CardTitle>
        <CardDescription>
          Prefer your existing tracker? Map your tab’s columns to GradeThread and
          sync by SKU instead of the generated tabs. Your inventory fields sync
          both ways; listing/sale columns are a read-only mirror. New rows with a
          new SKU become inventory items.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!editing && (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm">
              {activeMap ? (
                <span className="flex items-center gap-2">
                  <Badge variant="secondary">Custom</Badge>
                  Syncing your tab{" "}
                  <span className="font-medium">“{activeMap.tab}”</span> (
                  {activeMap.columns.length} columns mapped).
                </span>
              ) : (
                <span className="text-muted-foreground">
                  Using the generated tabs. Set up a mapping to use your own.
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={startEditing}>
                {activeMap ? "Edit mapping" : "Set up"}
              </Button>
              {activeMap && (
                <Button
                  variant="ghost"
                  onClick={() => clear.mutate()}
                  disabled={clear.isPending}
                >
                  Revert to generated tabs
                </Button>
              )}
            </div>
          </div>
        )}

        {editing && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label className="text-xs" htmlFor={tabId}>Your tab</Label>
                <Select value={tab} onValueChange={setTab}>
                  <SelectTrigger className="h-9 w-64" id={tabId}>
                    <SelectValue placeholder="Pick a tab…" />
                  </SelectTrigger>
                  <SelectContent>
                    {(tabs.data ?? []).map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={detect} disabled={!tab || suggest.isPending}>
                {suggest.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Wand2 className="mr-2 h-4 w-4" />
                )}
                Detect columns
              </Button>
            </div>

            {suggestion && (
              <>
                <div className="max-h-96 overflow-y-auto rounded-md border">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-muted/50 text-xs text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 text-left">Your column</th>
                        <th className="px-3 py-2 text-left">Maps to</th>
                      </tr>
                    </thead>
                    <tbody>
                      {suggestion.headers.map((h) => {
                        const chosen = choices[h] ?? UNMAPPED;
                        const f =
                          chosen !== UNMAPPED ? fieldsByKey.get(chosen) : undefined;
                        return (
                          <tr key={h} className="border-t">
                            <td className="px-3 py-1.5 font-medium">{h}</td>
                            <td className="px-3 py-1.5">
                              <div className="flex items-center gap-2">
                                <Select
                                  value={chosen}
                                  onValueChange={(v) =>
                                    setChoices((c) => ({ ...c, [h]: v }))
                                  }
                                >
                                  <SelectTrigger className="h-8 w-60 text-xs" aria-label={`Map column ${h} to`}>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value={UNMAPPED}>
                                      — Don’t sync —
                                    </SelectItem>
                                    {(suggestion.fields ?? []).map((mf) => (
                                      <SelectItem key={mf.field} value={mf.field}>
                                        {mf.label}
                                        {!mf.writable ? " (read-only)" : ""}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                {f?.role === "key" && (
                                  <Badge variant="secondary">key</Badge>
                                )}
                                {f && !f.writable && (
                                  <Badge variant="outline">mirror</Badge>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="createFromSheet"
                      checked={createFromSheet}
                      onCheckedChange={setCreateFromSheet}
                    />
                    <Label htmlFor="createFromSheet" className="text-xs">
                      New rows with a new SKU become GradeThread items
                    </Label>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="ghost" onClick={() => setEditing(false)}>
                      Cancel
                    </Button>
                    <Button onClick={onSave} disabled={save.isPending}>
                      {save.isPending && (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      )}
                      Save mapping
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  First sync is non-destructive — it fills empty GradeThread
                  fields from your sheet and never blanks your existing data. Tip:
                  try it on a copy of your workbook first.
                </p>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
