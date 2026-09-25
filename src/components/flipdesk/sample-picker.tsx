import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { uniqueNames } from "@/lib/starter-presets";
import type { StarterPreset } from "@/lib/starter-presets";

// US-2966: the "start from a sample" dialog, shared by description snippets
// and listing templates.
//
// The whole body of every sample is on screen, unscrolled and unsummarised.
// That is the point of the feature: a seller who has never written a snippet
// cannot judge one from its name, and a picker that showed nine titles would
// leave them exactly as stuck as the empty page did.
//
// Renaming happens HERE rather than in each page, because both tables reject a
// duplicate name and neither editor is open at the moment the rows are
// created. `uniqueNames` gets the account's existing names and returns what
// each pick will actually be called, which is also what the row shows the
// seller before they commit.

export interface SamplePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  samples: readonly StarterPreset[];
  /** Names already on the account, so a pick can be renamed out of the way. */
  taken: readonly string[];
  /** Cap for the renamed result — SNIPPET_NAME_MAX or TEMPLATE_NAME_MAX. */
  nameMax: number;
  /** "snippet" / "template". Pluralised with a bare "s". */
  noun: string;
  adding: boolean;
  /** Called with the picked samples and the name each one should be saved as. */
  onAdd: (picks: Array<{ sample: StarterPreset; name: string }>) => void;
  /**
   * How the last add went, when some picks did not save. The saved ones are
   * unticked and a line says which failed and why, so a retry sends only the
   * rest.
   */
  result?: {
    total: number;
    added: readonly string[];
    failed: ReadonlyArray<{ id: string; name: string; message: string }>;
  } | null;
  /** Progress while adding: how many picks are done out of how many. */
  progress?: { done: number; total: number } | null;
  /** A heading for the body text, e.g. "Footer" for templates. */
  bodyLabel?: string;
}

/**
 * The dialog's contents, split out so a test can render them.
 *
 * `DialogContent` goes through a Radix portal, which paints nothing under
 * `renderToStaticMarkup` — this repo's convention for component tests. Every
 * assertion worth making about this dialog is about the markup below, so the
 * portal wraps it rather than containing it.
 *
 * It also owns the tick state, which is why closing the dialog forgets it:
 * Radix unmounts the content, so a seller who adds three samples and comes
 * back for a fourth does not find the three still ticked.
 */
export function SamplePickerBody({
  onOpenChange,
  samples,
  taken,
  nameMax,
  noun,
  adding,
  onAdd,
  result = null,
  progress = null,
  bodyLabel,
}: Omit<SamplePickerProps, "open" | "title" | "description">) {
  const [checked, setChecked] = useState<string[]>([]);

  // Untick what saved, so the seller's retry only sends the failures.
  useEffect(() => {
    if (!result || result.added.length === 0) return;
    setChecked((prev) => prev.filter((id) => !result.added.includes(id)));
  }, [result]);

  const picked = samples.filter((s) => checked.includes(s.id));
  const names = uniqueNames(
    picked.map((s) => s.name),
    taken,
    nameMax,
  );

  function toggle(id: string) {
    setChecked((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  return (
    <>
      <ul className="divide-y divide-border">
        {samples.map((s) => {
          const on = checked.includes(s.id);
          // The name this pick will really be saved as, computed against the
          // account plus the picks above it, so a rename is visible before the
          // seller commits rather than surprising them afterwards.
          const finalName =
            (on ? names[picked.findIndex((p) => p.id === s.id)] : s.name) ??
            s.name;
          const renamed = on && finalName !== s.name;
          return (
            <li
              key={s.id}
              role="group"
              aria-labelledby={`sample-${s.id}-name`}
              className="flex items-start gap-3 py-3"
            >
              <Checkbox
                id={`sample-${s.id}`}
                className="mt-1"
                checked={on}
                disabled={adding}
                onCheckedChange={() => toggle(s.id)}
              />
              <div className="min-w-0 flex-1">
                {/* Only the name is the checkbox's label; the body and details
                    are read as the group's content, not as one long label. */}
                <label
                  htmlFor={`sample-${s.id}`}
                  id={`sample-${s.id}-name`}
                  className="block cursor-pointer font-medium"
                >
                  {finalName}
                </label>
                {renamed && (
                  <span className="block text-xs text-muted-foreground">
                    You already have one called &ldquo;{s.name}&rdquo;, so this
                    one gets a new name.
                  </span>
                )}
                {s.details && s.details.length > 0 && (
                  <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                    {s.details.map((d) => (
                      <div key={d.label} className="contents">
                        <dt className="font-medium text-muted-foreground">{d.label}</dt>
                        <dd>{d.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {bodyLabel && (
                  <span className="mt-1 block text-xs font-medium text-muted-foreground">
                    {bodyLabel}
                  </span>
                )}
                <span className="mt-1 block whitespace-pre-wrap text-sm text-muted-foreground">
                  {s.body}
                </span>
                {s.note && !s.details && (
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {s.note}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {result && result.failed.length > 0 && (
        <p role="alert" className="text-sm text-destructive">
          Added {result.added.length} of {result.total}.{" "}
          {result.failed.map((f) => `${f.name} did not save: ${f.message}`).join(" ")}
        </p>
      )}

      <DialogFooter>
        <Button
          variant="outline"
          disabled={adding}
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
        <Button
          disabled={adding || picked.length === 0}
          onClick={() =>
            onAdd(
              picked.map((sample, i) => ({
                sample,
                name: names[i] ?? sample.name,
              })),
            )
          }
        >
          {adding
            ? progress
              ? `Adding ${Math.min(progress.done + 1, progress.total)} of ${progress.total}...`
              : "Adding..."
            : picked.length === 0
              ? `Add ${noun}s`
              : `Add ${picked.length} ${noun}${picked.length === 1 ? "" : "s"}`}
        </Button>
      </DialogFooter>
    </>
  );
}

export function SamplePicker({
  open,
  title,
  description,
  ...rest
}: SamplePickerProps) {
  return (
    <Dialog open={open} onOpenChange={rest.onOpenChange}>
      {/* No max-height of its own: DialogContent already clamps to
          max-h-[calc(100dvh-2rem)], and US-2028 forbids a vh clamp because it
          hides content behind mobile browser chrome. */}
      <DialogContent className="overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <SamplePickerBody {...rest} />
      </DialogContent>
    </Dialog>
  );
}
