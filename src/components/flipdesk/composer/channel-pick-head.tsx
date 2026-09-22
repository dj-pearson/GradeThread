import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";

// US-3456: the tick, the marketplace name, how it is reached and why it
// cannot be ticked (or what the item is doing there). One row head, shared by
// the composer's List on panel (US-3450) and the bulk cross-list dialog, so
// the two cannot describe a channel in two vocabularies.

export interface ChannelPickHeadProps {
  id: string;
  label: string;
  mechanism: "api" | "extension";
  /** Why the row cannot be ticked, shown in brackets, or null. */
  blocked: string | null;
  /** What the item is doing there, shown when not blocked, or null. */
  word?: string | null;
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

export function ChannelPickHead({
  id,
  label,
  mechanism,
  blocked,
  word = null,
  checked,
  disabled = false,
  onToggle,
}: ChannelPickHeadProps) {
  return (
    <label htmlFor={id} className="flex min-w-0 items-center gap-2 text-sm">
      <Checkbox
        id={id}
        checked={checked}
        disabled={Boolean(blocked) || disabled}
        onCheckedChange={onToggle}
      />
      <span className="font-medium whitespace-nowrap">{label}</span>
      <Badge variant="outline" className="text-[10px] whitespace-nowrap">
        {mechanism === "api" ? "Connected via API" : "Via browser extension"}
      </Badge>
      {blocked ? (
        <span className="text-xs">({blocked})</span>
      ) : word ? (
        <span className="text-xs text-muted-foreground">{word}</span>
      ) : null}
    </label>
  );
}
