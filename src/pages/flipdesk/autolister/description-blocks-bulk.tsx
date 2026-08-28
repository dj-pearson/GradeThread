import { useState } from "react";
import { Loader2, Rows3 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { toastError } from "@/lib/toast-error";
import {
  applyBlockToggles,
  bulkBlockSummary,
  BULK_TOGGLE_KEYS,
  BULK_TOGGLE_LABELS,
  BULK_TOGGLE_WARNINGS,
  hasChanges,
  type BlockToggle,
  type BlockToggleSet,
} from "@/lib/description-block-bulk";

// US-2962: the description-section toggles, for a whole batch at once.
//
// TOGGLES ONLY. No block text is editable here, and that is the point rather
// than an omission: switching `measurements` off across forty drafts is one
// decision, and typing forty intros is not a bulk action however convenient a
// textarea in a toolbar would look.
//
// Three states per section. `Leave` is the default and means the draft keeps
// whatever it already had — without it, pressing Apply would assert a value for
// every section on the list, including the seven the seller never looked at.
//
// Extracted out of autolister-bulk-edit.tsx because that file sits on the
// shrink-only ceiling in src/test/autolister-split.test.ts. It holds its own
// toggle state and takes no page state: the ids to act on come in as a prop and
// the refresh goes back out as a callback.

const OPTIONS: { value: BlockToggle; label: string }[] = [
  { value: "keep", label: "Leave" },
  { value: "on", label: "Show" },
  { value: "off", label: "Hide" },
];

export function DescriptionBlocksBulk({
  targetIds,
  onApplied,
}: {
  /** The listings the toolbar is currently pointed at. */
  targetIds: string[];
  /** Refetch the grid — the descriptions on screen are now stale. */
  onApplied: () => void;
}) {
  const [toggles, setToggles] = useState<BlockToggleSet>({});
  const [running, setRunning] = useState(false);
  const ready = hasChanges(toggles) && targetIds.length > 0;

  async function apply() {
    setRunning(true);
    try {
      const result = await applyBlockToggles(targetIds, toggles);
      toast.success(bulkBlockSummary(result));
      setToggles({});
      onApplied();
    } catch (err) {
      toastError(err, "Those sections were not changed.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex items-end gap-1.5">
      <Popover>
        <PopoverTrigger asChild>
          <Button size="sm" variant="secondary">
            <Rows3 className="mr-1.5 h-3.5 w-3.5" />
            Description sections
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 space-y-3">
          <p className="text-xs text-muted-foreground">
            Show or hide a section across {targetIds.length}{" "}
            {targetIds.length === 1 ? "listing" : "listings"}. Anything left on{" "}
            <strong>Leave</strong> keeps what it already had. Only drafts are
            changed.
          </p>
          <div className="divide-y divide-border">
            {BULK_TOGGLE_KEYS.map((key) => (
              <div key={key} className="flex items-center justify-between gap-2 py-2">
                <span className="min-w-0 text-sm">
                  {BULK_TOGGLE_LABELS[key]}
                  {BULK_TOGGLE_WARNINGS[key] && toggles[key] === "off" && (
                    // Shown only once Hide is actually chosen: a standing
                    // caution on a row nobody touched is noise, and noise is
                    // how a real warning stops being read.
                    <span className="block text-xs text-destructive">
                      {BULK_TOGGLE_WARNINGS[key]}
                    </span>
                  )}
                </span>
                <div className="flex shrink-0 gap-1">
                  {OPTIONS.map((o) => (
                    <Button
                      key={o.value}
                      size="sm"
                      variant={
                        (toggles[key] ?? "keep") === o.value ? "default" : "outline"
                      }
                      className="h-7 px-2 text-xs"
                      aria-label={`${o.label} ${BULK_TOGGLE_LABELS[key]}`}
                      aria-pressed={(toggles[key] ?? "keep") === o.value}
                      onClick={() =>
                        setToggles((prev) => ({ ...prev, [key]: o.value }))
                      }
                    >
                      {o.label}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <Button
            size="sm"
            className="w-full"
            disabled={!ready || running}
            onClick={() => void apply()}
          >
            {running && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            Apply to {targetIds.length}{" "}
            {targetIds.length === 1 ? "listing" : "listings"}
          </Button>
        </PopoverContent>
      </Popover>
    </div>
  );
}
