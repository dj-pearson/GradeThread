import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, ArrowRight, Columns3, List, Table2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useEbayPolicies } from "@/hooks/use-ebay";
import { cn } from "@/lib/utils";
import { deriveListingOrigin } from "@/lib/listing-origin";
import { cellLock, DEFAULT_GRID_KEYS, GRID_GROUPS, INVENTORY_GRID_KEYS, validateGridValue, type GridCol, type GridRow } from "./grid-columns";

type CellElement = HTMLInputElement | HTMLSelectElement;
interface Props {
  rows: GridRow[];
  columns: GridCol[];
  allColumns: GridCol[];
  onColumns: (keys: string[]) => void;
  pageStart: number;
  saving: boolean;
  value: (row: GridRow, col: GridCol) => string;
  dirty: (id: string, field: string) => boolean;
  onChange: (row: GridRow, col: GridCol, value: string) => void;
  onKeyDown: (e: React.KeyboardEvent<CellElement>, rowIdx: number, colIdx: number, row: GridRow, col: GridCol) => void;
  onPaste: (e: React.ClipboardEvent<CellElement>, rowIdx: number, colIdx: number) => void;
}

function subscribeMobile(callback: () => void) {
  const media = window.matchMedia?.("(max-width: 767px)");
  media?.addEventListener("change", callback);
  return () => media?.removeEventListener("change", callback);
}

export function GridSheet(props: Props) {
  const { rows, columns, allColumns, onColumns, pageStart, saving, value, dirty, onChange, onKeyDown, onPaste } = props;
  const mobile = useSyncExternalStore(subscribeMobile, () => window.matchMedia?.("(max-width: 767px)").matches ?? false, () => false);
  const [layout, setLayout] = useState<"sheet" | "rows" | null>(null);
  const [rowIndex, setRowIndex] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [columnSearch, setColumnSearch] = useState("");
  const [compact, setCompact] = useState(false);
  const [fillOpen, setFillOpen] = useState(false);
  const [fillKey, setFillKey] = useState("");
  const [fillValue, setFillValue] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const topScrollRef = useRef<HTMLDivElement>(null);
  const showRows = layout ? layout === "rows" : mobile;
  const activeRow = rows[Math.min(rowIndex, rows.length - 1)];
  const policies = useEbayPolicies(columns.some(col => col.policy) && rows.some(row => row.listing?.platform === "ebay"));
  const identityWidth = mobile ? 132 : compact ? 160 : 200;
  const colWidth = (col: GridCol) => Math.round(col.width * (compact ? 0.8 : 1));
  const tableWidth = identityWidth + columns.reduce((sum, col) => sum + colWidth(col), 0);
  const importedCount = rows.filter(row => row.listing && deriveListingOrigin(row.listing) === "ebay").length;
  const fillColumn = columns.find(col => col.key === fillKey) ?? columns[0];
  const fillRows = fillColumn ? rows.filter(row => !cellLock(row, fillColumn)) : [];
  const fillError = fillColumn ? fillRows.map(row => validateGridValue(fillColumn, fillValue, row)).find(Boolean) : null;

  useEffect(() => { setRowIndex(0); }, [pageStart]);

  function scroll(direction: number) {
    const element = scrollRef.current;
    if (element) element.scrollBy({ left: direction * Math.max(160, element.clientWidth - identityWidth - 40), behavior: "auto" });
  }

  function renderCell(row: GridRow, col: GridCol, rowIdx: number, colIdx: number) {
    const rowNumber = pageStart + rowIdx + 1;
    const locked = cellLock(row, col);
    const changed = dirty(row.id, col.field);
    const error = changed ? validateGridValue(col, value(row, col), row) : null;
    const id = `grid-${row.id}-${colIdx}`;
    const options = col.policy
      ? (policies.data?.policies ?? []).filter(policy => policy.policy_type === col.policy).map(policy => ({ value: policy.policy_id, label: policy.policy_name }))
      : col.options;
    const current = value(row, col);
    const shared = {
      id,
      "data-grid-row": rowIdx,
      "data-grid-col": colIdx,
      "aria-label": `${col.label}, row ${rowNumber}`,
      "aria-invalid": !!error,
      "aria-describedby": error || locked ? `${id}-hint` : undefined,
      value: current,
      disabled: saving || !!locked,
      title: error ?? locked ?? current,
      onChange: (e: React.ChangeEvent<CellElement>) => onChange(row, col, e.target.value),
      onKeyDown: (e: React.KeyboardEvent<CellElement>) => {
        // Native selects need their arrow keys to choose options.
        if (options && (e.key === "ArrowDown" || e.key === "ArrowUp")) return;
        onKeyDown(e, rowIdx, colIdx, row, col);
      },
      onPaste: (e: React.ClipboardEvent<CellElement>) => onPaste(e, rowIdx, colIdx),
      className: cn(
        "block min-w-0 w-full rounded-none border-0 bg-transparent px-3 text-sm outline-none focus:relative focus:z-10 focus:bg-accent/10 focus:ring-2 focus:ring-inset focus:ring-primary disabled:cursor-not-allowed disabled:text-muted-foreground",
        compact && !showRows ? "h-9" : "h-11",
        showRows && "rounded-md border bg-background",
        col.numeric && "text-right tabular-nums",
        changed && "bg-amber-100 dark:bg-amber-950/40",
        error && "ring-2 ring-inset ring-destructive",
      ),
    };
    return <>
      {options ? <select {...shared}>
        <option value="">{col.policy ? "Choose policy" : "Choose condition"}</option>
        {current && !options.some(option => option.value === current) && <option value={current}>{current}</option>}
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select> : <input {...shared} inputMode={col.numeric ? (col.integer ? "numeric" : "decimal") : "text"}
        onFocus={e => e.currentTarget.select()} />}
      {(error || locked) && <span id={`${id}-hint`} className={showRows ? "mt-1 block text-xs text-muted-foreground" : "sr-only"}>{error ?? locked}</span>}
    </>;
  }

  return <section className="min-w-0 max-w-full overflow-hidden rounded-xl border bg-background" aria-label="Bulk listing editor">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={saving} onClick={() => setPickerOpen(true)}><Columns3 className="mr-2 h-4 w-4" />Columns ({columns.length}/{allColumns.length})</Button>
        <Button variant="outline" size="sm" disabled={saving} onClick={() => { setFillValue(""); setFillOpen(true); }}>Fill column</Button>
        <Button variant="ghost" size="sm" aria-pressed={!showRows} onClick={() => setLayout("sheet")}><Table2 className="mr-2 h-4 w-4" />Spreadsheet</Button>
        <Button variant="ghost" size="sm" aria-pressed={showRows} onClick={() => setLayout("rows")}><List className="mr-2 h-4 w-4" />One item</Button>
      </div>
      {!showRows && <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" aria-pressed={compact} onClick={() => setCompact(!compact)}>Compact</Button>
        <Button variant="outline" size="icon" aria-label="Scroll columns left" onClick={() => scroll(-1)}><ArrowLeft className="h-4 w-4" /></Button>
        <Button variant="outline" size="icon" aria-label="Scroll columns right" onClick={() => scroll(1)}><ArrowRight className="h-4 w-4" /></Button>
      </div>}
    </div>
    <p className="px-3 py-2 text-xs text-muted-foreground">
      {showRows ? "Edit the fields below, then move to the next item. Your changes stay until you save." : "Scroll sideways or use the arrows for more columns. Item names stay pinned. Tab moves between cells; Enter moves down."}
      {columns.some(col => col.group === "Item specifics") && " Separate multiple specific values with a semicolon."}
    </p>
    {importedCount > 0 && <p className="px-3 pb-2 text-xs text-muted-foreground">{importedCount} imported eBay listings have read-only listing fields. Their inventory fields can still be edited here.</p>}
    {policies.isError && columns.some(col => col.policy) && <p role="alert" className="px-3 pb-2 text-sm text-destructive">Policies could not load. <button className="underline" onClick={() => void policies.refetch()}>Retry policies</button></p>}
    {showRows && activeRow ? <div className="px-3 pb-4">
      <div className="sticky top-0 z-10 mb-4 flex items-center justify-between gap-3 border-y bg-background py-3">
        <div className="min-w-0"><p className="truncate text-sm font-medium">{activeRow.item_title}</p><p className="text-xs text-muted-foreground">Item {pageStart + Math.min(rowIndex, rows.length - 1) + 1} / {activeRow.item_number || "No SKU"}</p></div>
        <div className="flex gap-1"><Button variant="outline" size="icon" aria-label="Previous item" disabled={rowIndex <= 0} onClick={() => setRowIndex(index => Math.max(0, index - 1))}><ArrowLeft className="h-4 w-4" /></Button><Button variant="outline" size="icon" aria-label="Next item" disabled={rowIndex >= rows.length - 1} onClick={() => setRowIndex(index => Math.min(rows.length - 1, index + 1))}><ArrowRight className="h-4 w-4" /></Button></div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{columns.map((col, colIdx) => <div key={col.key} className="min-w-0">
        <label htmlFor={`grid-${activeRow.id}-${colIdx}`} className="mb-1 block text-sm font-medium">{col.label}</label>
        {renderCell(activeRow, col, Math.min(rowIndex, rows.length - 1), colIdx)}
      </div>)}</div>
    </div> : <>
      <div ref={topScrollRef} className="overflow-x-auto border-y" aria-label="Column scrollbar" tabIndex={0}
        onScroll={event => { if (scrollRef.current) scrollRef.current.scrollLeft = event.currentTarget.scrollLeft; }}>
        <div style={{ width: tableWidth, height: 16 }} />
      </div>
      <div ref={scrollRef} className="relative max-h-[65dvh] max-w-full overflow-auto overscroll-x-contain" tabIndex={0} role="region" aria-label="Scrollable listing cells"
        onScroll={event => { if (topScrollRef.current) topScrollRef.current.scrollLeft = event.currentTarget.scrollLeft; }}>
        <table className="table-fixed border-separate border-spacing-0 text-sm" style={{ width: tableWidth, minWidth: "100%" }} aria-label="Editable inventory grid">
          <colgroup><col style={{ width: identityWidth }} />{columns.map(col => <col key={col.key} style={{ width: colWidth(col) }} />)}</colgroup>
          <thead className="sticky top-0 z-20"><tr>
            <th scope="col" className="sticky left-0 z-30 border-b border-r bg-muted px-3 py-3 text-left font-medium">Item</th>
            {columns.map(col => <th key={col.key} scope="col" className="border-b border-r bg-muted px-3 py-3 text-left font-medium">{col.label}</th>)}
          </tr></thead>
          <tbody>{rows.map((row, rowIdx) => <tr key={row.id}>
            <th scope="row" className="sticky left-0 z-10 border-b border-r bg-background px-3 py-2 text-left font-normal">
              <p className="truncate font-medium" title={row.item_title}>{row.item_title}</p><p className="truncate text-xs text-muted-foreground">{pageStart + rowIdx + 1}. {row.item_number || "No SKU"}</p>
            </th>
            {columns.map((col, colIdx) => <td key={col.key} className="border-b border-r p-0">{renderCell(row, col, rowIdx, colIdx)}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
    </>}
    <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader><DialogTitle>Choose columns</DialogTitle><DialogDescription>Keep just the fields you need. Your choices are saved on this device. Hidden changes are still included when you save.</DialogDescription></DialogHeader>
        <input aria-label="Find a column" placeholder="Find a column" value={columnSearch} onChange={e => setColumnSearch(e.target.value)} className="h-11 w-full rounded-md border bg-background px-3 text-sm" />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => onColumns(DEFAULT_GRID_KEYS)}>Listing basics</Button>
          <Button variant="outline" size="sm" onClick={() => onColumns(INVENTORY_GRID_KEYS)}>Inventory</Button>
          <Button variant="outline" size="sm" onClick={() => onColumns(allColumns.map(col => col.key))}>Show all</Button>
        </div>
        {GRID_GROUPS.map(group => {
          const matching = allColumns.filter(col => col.group === group && col.label.toLowerCase().includes(columnSearch.toLowerCase()));
          if (!matching.length) return null;
          return <fieldset key={group}><legend className="mb-2 text-sm font-semibold">{group}</legend><div className="grid gap-1 sm:grid-cols-2">{matching.map(col => {
            const checked = columns.some(current => current.key === col.key);
            return <label key={col.key} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 text-sm hover:bg-muted"><input type="checkbox" checked={checked} disabled={checked && columns.length === 1} onChange={() => onColumns(checked ? columns.filter(current => current.key !== col.key).map(current => current.key) : [...columns.map(current => current.key), col.key])} />{col.label}</label>;
          })}</div></fieldset>;
        })}
        {!allColumns.some(col => col.label.toLowerCase().includes(columnSearch.toLowerCase())) && <p className="text-sm text-muted-foreground">No columns match that search.</p>}
        <Button onClick={() => setPickerOpen(false)}>Done</Button>
      </DialogContent>
    </Dialog>
    <Dialog open={fillOpen} onOpenChange={setFillOpen}>
      <DialogContent>
        <DialogHeader><DialogTitle>Fill a column on this page</DialogTitle><DialogDescription>Apply one value to {fillRows.length} editable items on this page. {rows.length - fillRows.length} locked items will be skipped. Review and save afterwards.</DialogDescription></DialogHeader>
        <label className="space-y-1 text-sm">Column<select aria-label="Column to fill" value={fillColumn?.key ?? ""} onChange={event => { setFillKey(event.target.value); setFillValue(""); }} className="block h-11 w-full rounded-md border bg-background px-3">{columns.map(col => <option key={col.key} value={col.key}>{col.label}</option>)}</select></label>
        <label className="space-y-1 text-sm">New value
          {fillColumn?.options || fillColumn?.policy ? <select aria-label="Fill value" value={fillValue} onChange={event => setFillValue(event.target.value)} className="block h-11 w-full rounded-md border bg-background px-3">
            <option value="">Choose a value</option>
            {(fillColumn.options ?? (policies.data?.policies ?? []).filter(policy => policy.policy_type === fillColumn.policy).map(policy => ({ value: policy.policy_id, label: policy.policy_name }))).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select> : <input aria-label="Fill value" value={fillValue} onChange={event => setFillValue(event.target.value)} inputMode={fillColumn?.numeric ? "decimal" : "text"} className="block h-11 w-full rounded-md border bg-background px-3" />}
        </label>
        {fillError && <p role="alert" className="text-sm text-destructive">{fillError}</p>}
        <Button disabled={!fillColumn || !fillRows.length || !!fillError} onClick={() => {
          if (!fillColumn) return;
          fillRows.forEach(row => onChange(row, fillColumn, fillValue));
          setFillOpen(false);
        }}>Apply to {fillRows.length} items</Button>
      </DialogContent>
    </Dialog>
  </section>;
}
