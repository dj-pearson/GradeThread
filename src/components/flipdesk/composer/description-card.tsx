import { useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronDown,
  ChevronRight,
  GripVertical,
  Loader2,
  MoveRight,
  Plus,
  RotateCw,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";
import { Link } from "react-router";
import { AiDiffChip } from "@/components/flipdesk/ai-diff-chip";
import {
  DescriptionPreview,
  type DerivedFieldCommit,
} from "@/components/flipdesk/composer/description-preview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { textChanged } from "@/lib/listing-ai-diff";
import { cn } from "@/lib/utils";
import {
  addSnippetBlock,
  anchorForBlock,
  BLOCK_LABELS,
  describeBlock,
  isEditable,
  isPinned,
  isRegenerable,
  moveBlock,
  removeBlockAt,
  setBlockTextAt,
  SOURCE_LABELS,
  toggleBlockAt,
  type BlockRowContext,
} from "@/lib/description-blocks";
import type { ListingAiSnapshot } from "@/types/database";
import type {
  DescriptionBlock,
  DescriptionBlockKey,
  DescriptionSegment,
} from "@/types/database";
import type { RewriteAction } from "@/hooks/use-ai-extract";

// US-2960: the description, as the ordered list of blocks it actually is.
//
// This card used to be one 14-row textarea, and that is what made the same fact
// appear in three places with only two of them updatable — a seller who fixed a
// measurement was left with prose advertising the old number and no way to clear
// it short of a full AI rewrite that threw away every other edit.
//
// So the description is rows now. Each row is one block: a switch, a source tag
// saying who owns its content, and either an in-place textarea (the seller's own
// prose) or a control that jumps to the field it reads (everything derived).
// Nothing here renders the description — the edge service does, and the preview
// panel at the bottom shows exactly what it returned, which is exactly what eBay
// receives.
//
// Design: docs/superpowers/specs/2026-08-27-modular-listing-descriptions-design.md

/** US-2961's settings page. One literal, so the two links cannot drift. */
const SNIPPETS_HREF = "/dashboard/flipdesk/settings/blocks";

export interface DescriptionCardProps {
  blocks: DescriptionBlock[];
  onBlocksChange: (next: DescriptionBlock[]) => void;
  /** The exact string eBay will receive, straight from the edge renderer. */
  preview: string;
  /**
   * The same render in pieces (US-3114), so the preview below can be clicked.
   * Empty means an edge that has not been redeployed yet: the panel falls back
   * to the read-only raw view rather than showing regions that lead nowhere.
   */
  segments: DescriptionSegment[];
  previewPending: boolean;
  /** False until the listing row exists — /preview needs one for context. */
  previewAvailable: boolean;
  blocksLoading: boolean;
  /**
   * True when the listing has a row but its blocks never arrived. The rows on
   * screen are a placeholder then, and saving would render over a real
   * description — so the card says so instead of pretending to work.
   */
  unavailable: boolean;
  /** These rows came from parsing a legacy description; nothing is stored yet. */
  converted: boolean;
  rowContext: BlockRowContext;
  /** The seller's saved snippets, for the "Add a snippet" menu (US-2961). */
  snippetOptions: { id: string; name: string }[];
  onRegenerate: (key: DescriptionBlockKey) => void;
  regenerating: DescriptionBlockKey | null;
  /** Scroll to and focus the composer card a derived block reads from. */
  onGoToField: (anchorId: string) => void;
  /** Current measurement values, for prefilling an inline measurement edit. */
  measurementValues: Record<string, number | string>;
  /** Write an item value a generated preview line renders (US-3114). */
  onDerivedCommit: DerivedFieldCommit;
  /** Which template group the item maps to. */
  group: string;
  applyTemplate: () => void;
  /** Regenerate-from-photos needs at least one photo. */
  photoCount: number;
  aiRewrite: { isPending: boolean };
  rewriteAction: string | null;
  runRewrite: (action: RewriteAction) => void;
  aiSnapshot: ListingAiSnapshot | null;
  onRevertToAi: (text: string) => void;
  isEbayOrigin: boolean;
  ebayOwnedHint: string | undefined;
}

export function DescriptionCard({
  blocks,
  onBlocksChange,
  preview,
  segments,
  previewPending,
  previewAvailable,
  blocksLoading,
  unavailable,
  converted,
  rowContext,
  snippetOptions,
  onRegenerate,
  regenerating,
  onGoToField,
  measurementValues,
  onDerivedCommit,
  group,
  applyTemplate,
  photoCount,
  aiRewrite,
  rewriteAction,
  runRewrite,
  aiSnapshot,
  onRevertToAi,
  isEbayOrigin,
  ebayOwnedHint,
}: DescriptionCardProps) {
  const [editing, setEditing] = useState<number | null>(null);
  // US-3114: open by default. The preview is where the seller works now — the
  // rows above are the structural controls (on/off, order, remove), and the
  // wording lives in the thing that shows the wording.
  const [previewOpen, setPreviewOpen] = useState(true);

  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor));

  function onDragEnd(event: DragEndEvent) {
    const from = Number(event.active.id);
    const to = event.over ? Number(event.over.id) : from;
    if (!Number.isInteger(from) || !Number.isInteger(to)) return;
    const next = moveBlock(blocks, from, to);
    if (next !== blocks) onBlocksChange(next);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Description</CardTitle>
            <CardDescription>
              Switch a section off, drag to reorder, edit one at a time. The{" "}
              <Badge variant="outline" className="capitalize">
                {group}
              </Badge>{" "}
              template seeds the intro.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={isEbayOrigin}
              title={ebayOwnedHint}
              onClick={applyTemplate}
            >
              <Wand2 className="mr-2 h-3 w-3" />
              Apply template
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" disabled={isEbayOrigin} title={ebayOwnedHint}>
                  <Plus className="mr-2 h-3 w-3" />
                  Add a snippet
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {snippetOptions.length === 0 ? (
                  <DropdownMenuItem asChild>
                    <Link to={SNIPPETS_HREF}>Write your first snippet</Link>
                  </DropdownMenuItem>
                ) : (
                  <>
                    {snippetOptions.map((s) => (
                      <DropdownMenuItem
                        key={s.id}
                        onClick={() => onBlocksChange(addSnippetBlock(blocks, s.id))}
                      >
                        {s.name}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuItem asChild>
                      <Link to={SNIPPETS_HREF}>Manage snippets</Link>
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={aiRewrite.isPending || isEbayOrigin}
                  title={ebayOwnedHint}
                >
                  {aiRewrite.isPending &&
                  rewriteAction?.startsWith("description_") ? (
                    <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                  ) : (
                    <Sparkles className="mr-2 h-3 w-3" />
                  )}
                  AI rewrite
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={!preview.trim()}
                  onClick={() => void runRewrite("description_tighten")}
                >
                  Tighten &amp; polish
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={photoCount === 0}
                  onClick={() => void runRewrite("description_regen")}
                >
                  Regenerate from photos
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {unavailable && (
          <p className="text-sm text-muted-foreground">
            Sections could not be loaded for this listing, so nothing here will
            save. Reload the page; if it keeps happening the description is
            unchanged and safe.
          </p>
        )}
        {converted && (
          <p className="text-xs text-muted-foreground">
            This listing was written before sections existed. What you see is
            your current description split up — nothing changes until you save.
          </p>
        )}

        {blocksLoading && blocks.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading sections…</p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
          >
            <SortableContext
              items={blocks.map((_, i) => String(i))}
              strategy={verticalListSortingStrategy}
            >
              <ul className="divide-y divide-border">
                {blocks.map((block, index) => (
                  <BlockRow
                    key={`${block.key}-${index}`}
                    id={String(index)}
                    block={block}
                    rowContext={rowContext}
                    editing={editing === index}
                    disabled={isEbayOrigin}
                    disabledHint={ebayOwnedHint}
                    regenerating={regenerating === block.key}
                    onToggle={() => onBlocksChange(toggleBlockAt(blocks, index))}
                    onEditToggle={() =>
                      setEditing((cur) => (cur === index ? null : index))
                    }
                    onTextChange={(text) =>
                      onBlocksChange(setBlockTextAt(blocks, index, text))
                    }
                    onRegenerate={() => onRegenerate(block.key)}
                    onRemove={
                      // Only the rows a seller ADDED can be removed. The nine
                      // standard sections are switched off instead, so their
                      // position survives and toggling back on restores it.
                      block.key === "snippet" || block.key === "text"
                        ? () => {
                            setEditing(null);
                            onBlocksChange(removeBlockAt(blocks, index));
                          }
                        : null
                    }
                    onGoToField={onGoToField}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}

        <div className="space-y-2">
          <Button
            variant="ghost"
            size="sm"
            className="px-2"
            onClick={() => setPreviewOpen((v) => !v)}
          >
            {previewOpen ? (
              <ChevronDown className="mr-2 h-3 w-3" />
            ) : (
              <ChevronRight className="mr-2 h-3 w-3" />
            )}
            Preview and edit
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {preview.length.toLocaleString()} characters
              {previewPending ? " · updating" : ""}
            </span>
          </Button>
          {previewOpen && (
            <DescriptionPreview
              segments={segments}
              preview={preview}
              pending={previewPending}
              available={previewAvailable}
              proseText={(index) => blocks[index]?.text ?? ""}
              onProseChange={(index, text) =>
                onBlocksChange(setBlockTextAt(blocks, index, text))
              }
              attributeValues={rowContext.attributes}
              measurementValues={measurementValues}
              onDerivedCommit={onDerivedCommit}
              onGoToField={onGoToField}
              disabled={isEbayOrigin}
              disabledHint={ebayOwnedHint}
            />
          )}
        </div>

        {aiSnapshot?.description && (
          <AiDiffChip
            changed={textChanged(aiSnapshot.description, preview)}
            aiDisplay="AI draft"
            onRevert={() => onRevertToAi(aiSnapshot.description ?? "")}
          />
        )}
      </CardContent>
    </Card>
  );
}

// ─── One row ───────────────────────────────────────────────────────

function BlockRow({
  id,
  block,
  rowContext,
  editing,
  disabled,
  disabledHint,
  regenerating,
  onToggle,
  onEditToggle,
  onTextChange,
  onRegenerate,
  onRemove,
  onGoToField,
}: {
  id: string;
  block: DescriptionBlock;
  rowContext: BlockRowContext;
  editing: boolean;
  disabled: boolean;
  disabledHint: string | undefined;
  regenerating: boolean;
  onToggle: () => void;
  onEditToggle: () => void;
  onTextChange: (text: string) => void;
  onRegenerate: () => void;
  /** Null on the nine standard sections, which are switched off, not removed. */
  onRemove: (() => void) | null;
  onGoToField: (anchorId: string) => void;
}) {
  const pinned = isPinned(block.key);
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable(
    { id, disabled: pinned || disabled },
  );
  const label = BLOCK_LABELS[block.key];
  const anchor = anchorForBlock(block.key);
  const summary = describeBlock(block, rowContext);

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn("flex items-start gap-3 py-3", !block.on && "opacity-50")}
    >
      {pinned || disabled ? (
        // A pinned row keeps its place: `facts` because US-2682 needs it last
        // for revise-in-place, `credentials` because the refresh cron expects to
        // find it where it is. A handle that snapped back would be worse.
        <span className="h-8 w-4 shrink-0" aria-hidden="true" />
      ) : (
        <button
          type="button"
          className="mt-1 h-6 w-4 shrink-0 cursor-grab text-muted-foreground"
          aria-label={`Reorder ${label}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>
      )}

      <Switch
        checked={block.on}
        onCheckedChange={onToggle}
        disabled={disabled}
        className="mt-1"
        aria-label={`Include ${label}`}
      />

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-sm font-medium">{label}</span>
          <span className="text-xs text-muted-foreground">
            {SOURCE_LABELS[block.src]}
          </span>
        </div>
        {editing ? (
          <Textarea
            value={block.text ?? ""}
            onChange={(e) => onTextChange(e.target.value)}
            rows={5}
            className="text-xs"
            placeholder={`Write the ${label.toLowerCase()} section.`}
            aria-label={`${label} text`}
          />
        ) : (
          <p className="truncate text-xs text-muted-foreground">{summary}</p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {isEditable(block.key) && (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            title={disabledHint}
            aria-label={`${editing ? "Done editing" : "Edit"} ${label}`}
            onClick={onEditToggle}
          >
            {editing ? "Done" : "Edit"}
          </Button>
        )}
        {isRegenerable(block.key) && (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled || regenerating}
            title={disabledHint}
            aria-label={`Rewrite ${label} with AI`}
            onClick={onRegenerate}
          >
            {regenerating ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RotateCw className="h-3 w-3" />
            )}
          </Button>
        )}
        {anchor && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Go to the ${label} fields`}
            onClick={() => onGoToField(anchor)}
          >
            <MoveRight className="h-3 w-3" />
          </Button>
        )}
        {onRemove && (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            title={disabledHint}
            aria-label={`Remove ${label}`}
            onClick={onRemove}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        )}
      </div>
    </li>
  );
}
