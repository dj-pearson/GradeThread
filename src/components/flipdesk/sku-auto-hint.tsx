import { TriangleAlert } from "lucide-react";
import { Link } from "react-router";
import { cn } from "@/lib/utils";
import { SKU_NUMBERING_HREF } from "@/lib/sku-presets";
import { useSkuSequence } from "@/hooks/use-sku-sequence";

// US-3418: one line under a SKU box.
//
// Before this, the SKU field was a bare text box with no hint that automatic
// numbering existed at all. A seller who never found the settings screen never
// got the feature, which is the same as not having built it.
//
// Three states, and the third matters as much as the other two: while the row
// is still loading this renders NOTHING, rather than a skeleton or a guess.
// Both alternatives push the form down a line and then move it again a moment
// later, under somebody who is mid-type.

export type SkuAutoHintProps = {
  /** The workspace owner. Omit for the signed-in user's own account. */
  ownerId?: string;
  className?: string;
};

export function SkuAutoHint({ ownerId, className }: SkuAutoHintProps) {
  const { nextSku, isEnabled, isExhausted, isLoading } = useSkuSequence(ownerId);

  if (isLoading) return null;

  if (isExhausted) {
    return (
      <p className={cn("text-xs text-destructive", className)}>
        Your SKU numbers have run out, so new items are saving without one.{" "}
        <Link to={SKU_NUMBERING_HREF} className="underline underline-offset-2">
          Add a digit
        </Link>
        .
      </p>
    );
  }

  // Numbering is on but the next value has not arrived yet. Saying "we will
  // number this" without being able to say WHICH number is worse than waiting a
  // beat, because the number is the whole reassurance.
  if (isEnabled && !nextSku) return null;

  if (isEnabled && nextSku) {
    return (
      <p className={cn("text-xs text-muted-foreground", className)}>
        Leave blank and we will use{" "}
        <span className="font-mono tabular-nums">{nextSku}</span>.{" "}
        <Link to={SKU_NUMBERING_HREF} className="underline underline-offset-2">
          Change
        </Link>
      </p>
    );
  }

  return (
    <p className={cn("text-xs text-muted-foreground", className)}>
      <Link to={SKU_NUMBERING_HREF} className="underline underline-offset-2">
        Number these automatically
      </Link>
    </p>
  );
}

/**
 * US-3418: the page-level warning for a sequence that has run out.
 *
 * US-3415 decided that an exhausted sequence leaves `sku` NULL rather than
 * failing the insert, because an unsaved item is worse than an unnumbered one
 * for somebody mid photo session. The price of that choice is that blank SKUs
 * start appearing in silence. This is what pays it.
 *
 * The wording is IDENTICAL to the banner on the settings screen on purpose. A
 * seller who sees both should not have to work out whether they are being told
 * about one problem or two.
 */
export function SkuExhaustedBanner({ ownerId, className }: SkuAutoHintProps) {
  const { isExhausted, isLoading } = useSkuSequence(ownerId);

  if (isLoading || !isExhausted) return null;

  return (
    <div
      role="status"
      className={cn(
        "mb-4 flex items-start gap-3 rounded-xl bg-destructive/10 px-4 py-3",
        className,
      )}
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <p className="text-sm">
        <span className="font-medium">
          Every number in this pattern has been used.
        </span>{" "}
        New items are saving without a SKU.{" "}
        <Link to={SKU_NUMBERING_HREF} className="underline underline-offset-2">
          Add a digit or a letter
        </Link>
        , then save.
      </p>
    </div>
  );
}
