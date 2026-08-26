import { useMemo, useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useAddSourcer, useSourcers } from "@/hooks/use-sourcers";
import { useWorkspace } from "@/hooks/use-workspace";

const NONE = "__none";
const NEW = "__new";

/**
 * A name typed before this field became a picker (or imported from a CSV) still
 * has to be selectable, or opening an old item would silently blank it. Returns
 * the value when it is NOT on the roster, else null.
 */
export function offRosterName(
  value: string,
  sourcers: Array<{ name: string }>,
): string | null {
  const v = value.trim();
  if (!v) return null;
  const known = sourcers.some((s) => s.name.toLowerCase() === v.toLowerCase());
  return known ? null : v;
}

interface SourcedBySelectProps {
  value: string;
  onChange: (next: string) => void;
  id?: string;
  /** Rendered above the control when set. Pass null to supply your own. */
  label?: string | null;
  className?: string;
  disabled?: boolean;
  /** Shown under the control. Set null for a compact layout. */
  hint?: string | null;
}

/**
 * US-2886: pick WHO sourced an item from the workspace roster instead of typing
 * a name. Teammates are on the roster automatically (00672); anyone else can be
 * added right here without leaving the form.
 *
 * The value written out is still the plain NAME, because that is what
 * `inventory_items.sourced_by` stores on every platform.
 */
export function SourcedBySelect({
  value,
  onChange,
  id = "sourced-by",
  label = "Sourced by",
  className,
  disabled,
  hint = null,
}: SourcedBySelectProps) {
  const { sourcers, isLoading } = useSourcers();
  const addSourcer = useAddSourcer();
  const { can } = useWorkspace();
  const canAdd = can("manage_inventory");

  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [saving, setSaving] = useState(false);

  const offRoster = useMemo(
    () => offRosterName(value, sourcers),
    [value, sourcers],
  );

  async function commitNew() {
    const name = draftName.trim();
    if (!name) {
      setAdding(false);
      return;
    }
    setSaving(true);
    try {
      const saved = await addSourcer(name);
      onChange(saved);
      setDraftName("");
      setAdding(false);
    } catch {
      toast.error("Couldn't add that person.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={cn("space-y-1.5", className)}>
      {label !== null && <Label htmlFor={id}>{label}</Label>}
      <Select
        value={value.trim() === "" ? NONE : value}
        disabled={disabled || isLoading}
        onValueChange={(v) => {
          if (v === NEW) {
            setAdding(true);
            return;
          }
          setAdding(false);
          onChange(v === NONE ? "" : v);
        }}
      >
        <SelectTrigger id={id} aria-label="Sourced by">
          <SelectValue placeholder="Select a person" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>— Not set —</SelectItem>
          {offRoster && (
            <SelectItem value={offRoster}>{offRoster} (not on roster)</SelectItem>
          )}
          {sourcers.map((s) => (
            <SelectItem key={s.id} value={s.name}>
              {s.isYou ? `${s.name} (you)` : s.name}
            </SelectItem>
          ))}
          {canAdd && <SelectItem value={NEW}>+ Add person…</SelectItem>}
        </SelectContent>
      </Select>

      {adding && (
        <div className="flex items-center gap-2 pt-1">
          <Input
            autoFocus
            aria-label="New person name"
            placeholder="Name (e.g. Tiff)"
            value={draftName}
            disabled={saving}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commitNew();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDraftName("");
                setAdding(false);
              }
            }}
          />
          <Button
            type="button"
            size="icon"
            variant="secondary"
            aria-label="Save person"
            disabled={saving || draftName.trim() === ""}
            onClick={() => void commitNew()}
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Cancel adding person"
            disabled={saving}
            onClick={() => {
              setDraftName("");
              setAdding(false);
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}

      {hint !== null && (
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
