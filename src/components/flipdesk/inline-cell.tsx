import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type Props = {
  value: string | number | null;
  onCommit: (next: string) => Promise<void> | void;
  type?: "text" | "number";
  align?: "left" | "right";
  className?: string;
  placeholder?: string;
};

// Click-to-edit cell. Save on Enter or blur, cancel on Esc.
export function InlineCell({
  value,
  onCommit,
  type = "text",
  align = "left",
  className,
  placeholder = "—",
}: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(value == null ? "" : String(value));
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value == null ? "" : String(value));
  }, [value, editing]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  async function commit() {
    if (saving) return;
    const trimmed = draft.trim();
    const current = value == null ? "" : String(value);
    if (trimmed === current.trim()) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onCommit(trimmed);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type={type}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(value == null ? "" : String(value));
            setEditing(false);
          }
        }}
        disabled={saving}
        className={cn(
          "w-full rounded-sm bg-background px-1 outline-none ring-1 ring-brand-navy",
          align === "right" && "text-right tabular-nums",
          className,
        )}
      />
    );
  }

  const display =
    value == null || value === ""
      ? null
      : type === "number"
        ? Number(value).toFixed(2)
        : String(value);

  return (
    <div
      tabIndex={0}
      onClick={() => setEditing(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setEditing(true);
        }
      }}
      role="button"
      className={cn(
        "cursor-text rounded-sm px-1 -mx-1 hover:bg-muted/60 focus:bg-muted focus:outline-none",
        align === "right" && "text-right tabular-nums",
        className,
      )}
    >
      {display ?? (
        <span className="text-muted-foreground/40">{placeholder}</span>
      )}
    </div>
  );
}
