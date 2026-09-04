import { useEffect, useRef, useState } from "react";
import { Loader2, MoveRight, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  anchorForBlock,
  BLOCK_LABELS,
  isEditable,
  SOURCE_LABELS,
} from "@/lib/description-blocks";
import type {
  DescriptionBlockKey,
  DescriptionSegment,
  DescriptionSegmentLine,
} from "@/types/database";

// US-3114: the preview you can click.
//
// The panel used to be a read-only monospace textarea, which meant a seller who
// spotted a wrong word had to work out which of nine rows above owned it, open
// that row and find the word again. Now every region of the preview knows which
// block rendered it, so clicking the sentence edits the sentence.
//
// THE ONE RULE THAT MAKES IT HONEST. The regions are not a second rendering.
// The edge returns `segments`, and gluing `sep + body` across them IS the string
// it publishes — asserted byte for byte in description-segments_test.ts. So a
// seller is never editing a pretty approximation of their listing.
//
// WHAT RENDERS AS MARKUP. Only the three GradeThread-built blocks: the facts
// table, the disclosure and the seller credentials, all of them escaped at the
// source in the edge service. Seller prose and AI prose stay escaped text
// however they are written, because a description is a place a seller can type
// anything and the composer is not a place to find out what.

/** Commit an item value a derived line renders. Resolves once it has landed. */
export type DerivedFieldCommit = (
  key: DescriptionBlockKey,
  field: string,
  value: string,
) => Promise<void>;

export interface DescriptionPreviewProps {
  /** The render in pieces. Empty falls back to the raw string. */
  segments: DescriptionSegment[];
  /** The exact bytes, for the raw view and the fallback. */
  preview: string;
  pending: boolean;
  /** False until the listing has a row — /preview needs one for context. */
  available: boolean;
  /** Current stored text of a prose block, by its index in the blocks array. */
  proseText: (index: number) => string;
  onProseChange: (index: number, text: string) => void;
  /** Current item column values, for prefilling an attributes input. */
  attributeValues: Record<string, string | null | undefined>;
  /** Current measurement values, for prefilling a measurements input. */
  measurementValues: Record<string, number | string>;
  onDerivedCommit: DerivedFieldCommit;
  onGoToField: (anchorId: string) => void;
  disabled: boolean;
  disabledHint?: string;
}

/** Which line the seller has open. `field` absent means the whole prose block. */
interface EditTarget {
  index: number;
  field?: string;
}

export function DescriptionPreview({
  segments,
  preview,
  pending,
  available,
  proseText,
  onProseChange,
  attributeValues,
  measurementValues,
  onDerivedCommit,
  onGoToField,
  disabled,
  disabledHint,
}: DescriptionPreviewProps) {
  const [raw, setRaw] = useState(false);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  // A block that stops being rendered — switched off, or emptied — takes its
  // open editor with it. Without this the textarea would hang over a region
  // that is no longer in the preview.
  useEffect(() => {
    if (!editing) return;
    if (!segments.some((s) => s.index === editing.index)) setEditing(null);
  }, [segments, editing]);

  if (!available) {
    return (
      <p className="text-sm text-muted-foreground">
        Save the draft once and the rendered description shows up here.
      </p>
    );
  }

  if (raw || segments.length === 0) {
    return (
      <div className="space-y-2">
        <RawToggle raw={raw} setRaw={setRaw} hasSegments={segments.length > 0} />
        <Textarea
          readOnly
          value={preview}
          rows={14}
          className="font-mono text-xs"
          aria-label="Rendered description preview"
        />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <RawToggle raw={raw} setRaw={setRaw} hasSegments />
      <div
        className="space-y-4 rounded-xl border bg-background p-4 text-sm leading-relaxed"
        aria-label="Description preview"
      >
        {segments.map((seg) => (
          <SegmentRegion
            key={`${seg.key}-${seg.index}`}
            seg={seg}
            editing={editing?.index === seg.index ? editing : null}
            setEditing={setEditing}
            saving={saving}
            setSaving={setSaving}
            proseText={proseText}
            onProseChange={onProseChange}
            attributeValues={attributeValues}
            measurementValues={measurementValues}
            onDerivedCommit={onDerivedCommit}
            onGoToField={onGoToField}
            disabled={disabled}
            disabledHint={disabledHint}
          />
        ))}
        {pending && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Updating
          </p>
        )}
      </div>
    </div>
  );
}

function RawToggle({
  raw,
  setRaw,
  hasSegments,
}: {
  raw: boolean;
  setRaw: (v: boolean) => void;
  hasSegments: boolean;
}) {
  if (!hasSegments) return null;
  return (
    <div className="flex items-center justify-between gap-2">
      {/* The regions only reveal themselves on hover, so the one line that says
          they are there earns its space. Without it the whole feature is
          invisible to anyone who never happens to hover the right paragraph. */}
      <p className="text-xs text-muted-foreground">
        {raw
          ? "The exact text eBay receives, markers and all."
          : "Click any part of this to edit it."}
      </p>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        aria-pressed={raw}
        onClick={() => setRaw(!raw)}
      >
        {raw ? "Show the finished look" : "Show raw"}
      </Button>
    </div>
  );
}

// ─── One region ────────────────────────────────────────────────────

function SegmentRegion({
  seg,
  editing,
  setEditing,
  saving,
  setSaving,
  proseText,
  onProseChange,
  attributeValues,
  measurementValues,
  onDerivedCommit,
  onGoToField,
  disabled,
  disabledHint,
}: {
  seg: DescriptionSegment;
  editing: EditTarget | null;
  setEditing: (t: EditTarget | null) => void;
  saving: string | null;
  setSaving: (v: string | null) => void;
  proseText: (index: number) => string;
  onProseChange: (index: number, text: string) => void;
  attributeValues: Record<string, string | null | undefined>;
  measurementValues: Record<string, number | string>;
  onDerivedCommit: DerivedFieldCommit;
  onGoToField: (anchorId: string) => void;
  disabled: boolean;
  disabledHint?: string;
}) {
  const label = BLOCK_LABELS[seg.key];
  const anchor = anchorForBlock(seg.key);
  const prose = isEditable(seg.key);

  return (
    <section
      className="group/seg relative rounded-md"
      aria-label={`${label} section`}
    >
      <header className="mb-1 flex items-baseline gap-2 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover/seg:opacity-100 group-focus-within/seg:opacity-100">
        <span className="font-medium">{label}</span>
        <span>{SOURCE_LABELS[seg.src]}</span>
        {anchor && (
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1 text-[11px]"
            aria-label={`Go to the ${label} fields`}
            onClick={() => onGoToField(anchor)}
          >
            <MoveRight className="mr-1 h-3 w-3" />
            Fields
          </Button>
        )}
      </header>

      {seg.kind === "html" ? (
        // GradeThread-built markup, escaped at the source in the edge service.
        // Nothing a seller or the model wrote reaches this branch: the edge
        // marks only facts, disclosure and credentials as html.
        <div
          className="text-xs [&_li]:my-0.5 [&_table]:w-full [&_ul]:list-disc [&_ul]:pl-5"
          dangerouslySetInnerHTML={{ __html: seg.html ?? "" }}
        />
      ) : prose ? (
        <ProseRegion
          seg={seg}
          label={label}
          editing={!!editing && editing.field === undefined}
          setEditing={setEditing}
          text={proseText(seg.index)}
          onChange={(t) => onProseChange(seg.index, t)}
          disabled={disabled}
          disabledHint={disabledHint}
        />
      ) : (
        <ul className="space-y-0.5">
          {(seg.lines ?? []).map((line, i) => (
            <LineRegion
              // Position is the identity here: two lines can render the same
              // bytes, and a key made of the text would collapse them.
              key={`${seg.index}-${i}`}
              seg={seg}
              line={line}
              editing={!!editing && editing.field === line.field && !!line.field}
              setEditing={setEditing}
              saving={saving}
              setSaving={setSaving}
              currentValue={
                line.field === undefined
                  ? ""
                  : seg.key === "measurements"
                  ? String(measurementValues[line.field] ?? "")
                  : String(attributeValues[line.field] ?? "")
              }
              onDerivedCommit={onDerivedCommit}
              disabled={disabled}
              disabledHint={disabledHint}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

// ─── Prose: the whole block is one editor ──────────────────────────

function ProseRegion({
  seg,
  label,
  editing,
  setEditing,
  text,
  onChange,
  disabled,
  disabledHint,
}: {
  seg: DescriptionSegment;
  label: string;
  editing: boolean;
  setEditing: (t: EditTarget | null) => void;
  text: string;
  onChange: (text: string) => void;
  disabled: boolean;
  disabledHint?: string;
}) {
  // A snippet block stores nothing until it is overridden, so the editor seeds
  // from what is actually rendered — the account body. Typing the first
  // character is what turns it into a per-listing override.
  const value = text || seg.body;

  if (editing) {
    return (
      <Textarea
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setEditing(null)}
        onKeyDown={(e) => {
          // Escape closes the editor. Enter does NOT — this is prose, and a
          // paragraph break is the commonest thing typed into it.
          if (e.key === "Escape") setEditing(null);
        }}
        rows={4}
        className="text-sm"
        aria-label={`${label} text`}
      />
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      title={disabledHint}
      aria-label={`Edit ${label}`}
      className={cn(
        "-mx-1 block w-full rounded px-1 text-left whitespace-pre-wrap",
        "hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        disabled && "cursor-default hover:bg-transparent",
      )}
      onClick={() => !disabled && setEditing({ index: seg.index })}
    >
      {seg.body}
      {!disabled && (
        <Pencil className="ml-1 inline h-3 w-3 align-baseline text-muted-foreground opacity-0 group-hover/seg:opacity-100" />
      )}
    </button>
  );
}

// ─── A generated line: edits the field behind it ───────────────────

function LineRegion({
  seg,
  line,
  editing,
  setEditing,
  saving,
  setSaving,
  currentValue,
  onDerivedCommit,
  disabled,
  disabledHint,
}: {
  seg: DescriptionSegment;
  line: DescriptionSegmentLine;
  editing: boolean;
  setEditing: (t: EditTarget | null) => void;
  saving: string | null;
  setSaving: (v: string | null) => void;
  currentValue: string;
  onDerivedCommit: DerivedFieldCommit;
  disabled: boolean;
  disabledHint?: string;
}) {
  const [draft, setDraft] = useState(currentValue);
  // A commit that resolves re-renders the whole preview from the server, so the
  // guard stops a blur firing a second write on the way out.
  const committed = useRef(false);

  // The markers are part of the bytes eBay receives and mean nothing to a
  // seller, so the raw view is where they show and this view is not.
  if (line.hidden) return null;

  const field = line.field;
  // A header or a note: shown, but there is nothing behind it to edit.
  if (!field) {
    return <li className="text-muted-foreground">{line.text}</li>;
  }

  const busy = saving === `${seg.index}:${field}`;

  const commit = async () => {
    if (committed.current) return;
    committed.current = true;
    const next = draft.trim();
    setEditing(null);
    if (next === currentValue.trim()) return;
    setSaving(`${seg.index}:${field}`);
    try {
      await onDerivedCommit(seg.key, field, next);
    } finally {
      setSaving(null);
    }
  };

  if (editing) {
    return (
      <li className="flex items-center gap-2">
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
            if (e.key === "Escape") {
              committed.current = true;
              setEditing(null);
            }
          }}
          className="h-7 max-w-xs text-sm"
          aria-label={`${field} value`}
        />
      </li>
    );
  }

  return (
    <li>
      <button
        type="button"
        disabled={disabled || busy}
        title={disabledHint}
        aria-label={`Edit ${field}`}
        className={cn(
          "-mx-1 w-full rounded px-1 text-left",
          "hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          disabled && "cursor-default hover:bg-transparent",
        )}
        onClick={() => {
          if (disabled) return;
          committed.current = false;
          setDraft(currentValue);
          setEditing({ index: seg.index, field });
        }}
      >
        {line.text}
        {busy && <Loader2 className="ml-2 inline h-3 w-3 animate-spin" />}
      </button>
    </li>
  );
}
