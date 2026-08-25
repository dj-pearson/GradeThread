import {
  ChevronsDownUp,
  ChevronsUpDown,
  Combine,
  FolderInput,
  Layers,
  Loader2,
  Plus,
  Sparkles,
  Tags,
  Trash2,
  Undo2,
  Ungroup,
  Wand2,
  ArrowUpDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// US-2520 / US-2621: the four button rows above the grouping workbench, lifted
// out of autolister.tsx when US-2621 pushed it back over its ratchet. They are
// prop-only renderers — every value and every callback comes from the page, and
// nothing here reads page state, runs a query or touches a store.
//
// US-2621 is also why there are FOUR of them rather than two. The tools that
// are always available and the actions that only make sense for a selection
// used to share one wrapping row, so the button a seller wanted after picking
// photos sat in the middle of buttons they did not want. A selection bar that
// appears only when there is a selection, holds nothing else, and sticks to the
// top of the viewport is the fix; keeping them as separate components is what
// stops the two from drifting back together.

/** Enough of a group to label a row in the "add to which item" menu. */
export interface ToolbarGroup {
  id: string;
  name: string;
  photoCount: number;
}

export interface ToolbarProgress {
  done: number;
  total: number;
}

const SELECTION_BAR_CLASS =
  "flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-background/95 p-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80";

/** The always-available grouping tools above the Ungrouped grid. */
export function UngroupedToolbar({
  ungroupedCount,
  entitled,
  sort,
  sortOptions,
  onSortChange,
  canUndoAutoGroup,
  onUndoAutoGroup,
  onAutoGroup,
  proposing,
  onPropose,
  proposeProgress,
  onStopPropose,
  groupEvery,
  onGroupEveryChange,
  onGroupEveryN,
}: {
  ungroupedCount: number;
  entitled: boolean;
  sort: string;
  sortOptions: { value: string; label: string }[];
  onSortChange: (value: string) => void;
  canUndoAutoGroup: boolean;
  onUndoAutoGroup: () => void;
  onAutoGroup: () => void;
  proposing: boolean;
  onPropose: () => void;
  proposeProgress: ToolbarProgress | null;
  onStopPropose: () => void;
  groupEvery: number;
  onGroupEveryChange: (value: number) => void;
  onGroupEveryN: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* US-1550: user-selectable grid order. */}
      <div
        className="flex items-center gap-1"
        title="Order the grid — grouping tools follow this order"
      >
        <ArrowUpDown className="h-4 w-4 text-muted-foreground" />
        <Select value={sort} onValueChange={onSortChange}>
          <SelectTrigger size="sm" className="h-8 w-[140px]" aria-label="Sort photos by">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sortOptions.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {canUndoAutoGroup && (
        <Button
          size="sm"
          variant="outline"
          onClick={onUndoAutoGroup}
          title="Dissolve the groups the last Auto-group run created — those photos return here"
        >
          <Undo2 className="mr-1 h-4 w-4" />
          Undo auto-group
        </Button>
      )}
      <Button
        size="sm"
        onClick={onAutoGroup}
        disabled={ungroupedCount === 0}
        title="Sort photos into items for you, using when each was taken and how alike they look"
      >
        <Wand2 className="mr-1 h-4 w-4" />
        Auto-group ({ungroupedCount})
      </Button>
      {/* US-1904: AI group remaining — a vision pass proposes item boundaries
          for a timeless dump auto-group can't split. Appears once there are ≥2
          ungrouped photos left. */}
      {entitled && ungroupedCount >= 2 && (
        <Button
          size="sm"
          variant="outline"
          onClick={onPropose}
          disabled={proposing}
          title="AI looks at the remaining photos in shooting order and proposes where each item begins (uses AI actions — you'll see the count first)"
        >
          {proposing ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="mr-1 h-4 w-4" />
          )}
          AI group remaining
        </Button>
      )}
      {proposeProgress && (
        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          Proposed {proposeProgress.done}/{proposeProgress.total} photos…
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={onStopPropose}
          >
            Stop
          </button>
        </span>
      )}
      {/* US-1550: fixed-size chunking in the displayed order — the rescue tool
          when photos carry no capture times for Auto-group to use. */}
      <div
        className="flex items-center gap-1"
        title="Cut the grid into items of exactly this many photos, in the order shown"
      >
        <Button
          size="sm"
          variant="secondary"
          onClick={onGroupEveryN}
          disabled={ungroupedCount === 0}
        >
          <Layers className="mr-1 h-4 w-4" />
          Group every
        </Button>
        <Input
          type="number"
          min={1}
          max={24}
          value={Number.isFinite(groupEvery) ? groupEvery : ""}
          onChange={(e) => onGroupEveryChange(e.target.valueAsNumber)}
          aria-label="Photos per item"
          className="h-8 w-16"
        />
      </div>
    </div>
  );
}

/**
 * What a selection of ungrouped photos can do. Sticky, because a selection made
 * 400 photos down the grid is useless if its buttons are at the top of a page
 * you have to scroll back up to.
 */
export function PhotoSelectionBar({
  count,
  groups,
  onNewGroup,
  onAddToGroup,
  onDelete,
  onClear,
}: {
  count: number;
  groups: ToolbarGroup[];
  onNewGroup: () => void;
  onAddToGroup: (groupId: string) => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  if (count === 0) return null;
  return (
    <div
      role="toolbar"
      aria-label="Actions for the selected photos"
      className={`sticky top-0 z-20 mb-2 ${SELECTION_BAR_CLASS}`}
    >
      <span className="pl-1 text-sm font-medium text-foreground">
        {count} photo{count === 1 ? "" : "s"} selected
      </span>
      <Button size="sm" onClick={onNewGroup}>
        <Plus className="mr-1 h-4 w-4" />
        New item from these
      </Button>
      {/* US-2621: the strays left over after auto-grouping usually belong to an
          item that already exists. */}
      {groups.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="secondary">
              <FolderInput className="mr-1 h-4 w-4" />
              Add to an existing item
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-72 w-64 overflow-y-auto">
            <DropdownMenuLabel>Add to which item</DropdownMenuLabel>
            {groups.map((g, i) => (
              <DropdownMenuItem key={g.id} onClick={() => onAddToGroup(g.id)}>
                <span className="truncate">{g.name || `Item ${i + 1}`}</span>
                <span className="ml-auto pl-2 text-xs text-muted-foreground">
                  {g.photoCount}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Button size="sm" variant="destructive" onClick={onDelete}>
        <Trash2 className="mr-1 h-4 w-4" />
        Delete
      </Button>
      <button
        type="button"
        onClick={onClear}
        className="ml-auto pr-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Clear selection
      </button>
    </div>
  );
}

/** The always-available tools above the list of items to generate. */
export function GroupsToolbar({
  groupCount,
  busy,
  verifying,
  onVerify,
  verifyProgress,
  onStopVerify,
  tagging,
  onAutoTagAll,
  collapsed,
  onToggleCollapsed,
  onUngroupAll,
}: {
  groupCount: number;
  busy: boolean;
  verifying: boolean;
  onVerify: () => void;
  verifyProgress: ToolbarProgress | null;
  onStopVerify: () => void;
  tagging: boolean;
  onAutoTagAll: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onUngroupAll: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      {/* US-1544/US-1903: on-demand AI grouping sanity check. Large sessions
          are checked across sequential windows (1 AI action each); progress
          shows below and the pass can be stopped. */}
      <Button
        size="sm"
        variant="outline"
        onClick={onVerify}
        disabled={verifying || groupCount < 2}
        title="AI compares your groups: flags likely merges, splits, and misplaced photos — suggestions only, nothing is changed automatically. Large sessions are checked in batches (1 AI action each)."
      >
        {verifying ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
        ) : (
          <Sparkles className="mr-1 h-4 w-4" />
        )}
        Verify groups
      </Button>
      {verifyProgress && (
        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          Checked {verifyProgress.done}/{verifyProgress.total} groups…
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={onStopVerify}
          >
            Stop
          </button>
        </span>
      )}
      <Button
        size="sm"
        variant="secondary"
        onClick={onAutoTagAll}
        disabled={tagging}
        title="Pick the best cover and tag each photo's role with AI"
      >
        {tagging ? (
          <Loader2 className="mr-1 h-4 w-4 animate-spin" />
        ) : (
          <Tags className="mr-1 h-4 w-4" />
        )}
        Auto-tag all
      </Button>
      {/* US-1907: collapse every group to a header-only overview. */}
      <Button
        size="sm"
        variant="outline"
        onClick={onToggleCollapsed}
        aria-pressed={collapsed}
        title={
          collapsed
            ? "Expand every group to show its photos"
            : "Collapse every group to a header-only overview"
        }
      >
        {collapsed ? (
          <ChevronsUpDown className="mr-1 h-4 w-4" />
        ) : (
          <ChevronsDownUp className="mr-1 h-4 w-4" />
        )}
        {collapsed ? "Expand all" : "Collapse all"}
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={onUngroupAll}
        disabled={busy}
        title="Dissolve every group — all photos return to Ungrouped (nothing is deleted)"
      >
        <Ungroup className="mr-1 h-4 w-4" />
        Ungroup all
      </Button>
    </div>
  );
}

/**
 * What a selection of ITEMS can do. Before US-2621 the checkboxes on the item
 * cards fed exactly one button, "Merge", which lived up in the header row — so
 * ticking a box and looking around for what to do next found nothing.
 */
export function GroupSelectionBar({
  count,
  canGenerate,
  onGenerate,
  onMerge,
  onUngroup,
  onClear,
}: {
  count: number;
  canGenerate: boolean;
  onGenerate: () => void;
  onMerge: () => void;
  onUngroup: () => void;
  onClear: () => void;
}) {
  if (count === 0) return null;
  return (
    <div
      role="toolbar"
      aria-label="Actions for the selected items"
      className={`sticky top-0 z-30 ${SELECTION_BAR_CLASS}`}
    >
      <span className="pl-1 text-sm font-medium text-foreground">
        {count} item{count === 1 ? "" : "s"} selected
      </span>
      <Button
        size="sm"
        onClick={onGenerate}
        disabled={!canGenerate}
        title="Send just these items to the AI. Everything else stays in this session."
      >
        <Sparkles className="mr-1 h-4 w-4" />
        Generate {count}
      </Button>
      {count >= 2 && (
        <Button
          size="sm"
          variant="secondary"
          onClick={onMerge}
          title="Combine these into one item — the first one's name and cover win"
        >
          <Combine className="mr-1 h-4 w-4" />
          Merge into one
        </Button>
      )}
      <Button
        size="sm"
        variant="secondary"
        onClick={onUngroup}
        title="Break these items up — their photos go back to Ungrouped. Nothing is deleted."
      >
        <Ungroup className="mr-1 h-4 w-4" />
        Ungroup
      </Button>
      <button
        type="button"
        onClick={onClear}
        className="ml-auto pr-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        Clear selection
      </button>
    </div>
  );
}
