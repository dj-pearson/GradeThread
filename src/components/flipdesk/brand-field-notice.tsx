// US-3307 AC2: a seller-visible way to record the real maker.
//
// The brand field is free text and sellers type what the garment shows them, so
// some of what lands there is not a maker at all. Measured on prod 2026-09-06,
// two of the top twenty-five values by item count were "norman rockwell", an
// illustrator whose estate licenses images onto blanks, and "cashmere", a fibre.
// Both were correctly refused from the brand knowledge base, and refusing them
// changed nothing about the items: those garments have a maker, it is sewn at
// the collar, and nobody recorded it.
//
// Until now the value was either silently trusted (the grader gets a licensor as
// brand context, the comp search queries a fibre, the size-chart resolver finds
// nothing and falls through to the generic path) or silently ignored (the
// brand-KB gap report ranks it as demand). Neither told the seller anything.
//
// ── The Unbranded distinction, which is the point of AC4 ────────────────────
//
// eBay ships "Unbranded" as a real Brand aspect value, so a seller who typed it
// answered the question. An empty field is a question nobody answered. The
// publish path defaults an empty brand to the literal string "Unbranded" to
// satisfy eBay's Brand+MPN requirement, which turns "we do not know" into a
// public claim that the garment has no maker. So this panel gives the seller an
// explicit button for the real answer and keeps the two apart everywhere else.

import { useState } from "react";
import { Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { classifyBrandField } from "@/lib/brand-field-classification";

export interface BrandFieldNoticeProps {
  /** The item's current brand column. */
  brand: string | null | undefined;
  /**
   * Writes the maker. Called with the typed value, or with "Unbranded" when the
   * seller says the garment carries no label. The composer routes this through
   * commitDerivedField, which writes the item column AND the eBay Brand
   * specific in one go (US-557 single-entry).
   */
  onRecordMaker: (value: string) => void | Promise<void>;
  /** True while a save is in flight or the listing is eBay-owned. */
  disabled?: boolean;
}

export function BrandFieldNotice({
  brand,
  onRecordMaker,
  disabled = false,
}: BrandFieldNoticeProps) {
  const [maker, setMaker] = useState("");
  const [busy, setBusy] = useState(false);
  const verdict = classifyBrandField(brand);

  async function record(value: string) {
    if (busy || disabled) return;
    setBusy(true);
    try {
      await onRecordMaker(value);
      setMaker("");
    } finally {
      setBusy(false);
    }
  }

  // A real maker is on file. Nothing to say.
  if (verdict.class === "maker") return null;

  // A recorded answer, not a gap. Said quietly and said explicitly, because the
  // whole point is that this is DIFFERENT from an empty field.
  if (verdict.class === "unbranded") {
    return (
      <p className="mb-4 flex items-start gap-2 text-xs text-muted-foreground">
        <Tag className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>
          Recorded as <span className="text-foreground">{verdict.value}</span>:
          this garment carries no maker&apos;s label. That is an answer, not a
          blank, and it publishes to eBay as-is.
        </span>
      </p>
    );
  }

  const headline =
    verdict.class === "blank" || verdict.class === "unknown"
      ? "No maker recorded for this item"
      : `${verdict.value} is not the maker`;

  return (
    <Card className="mb-4">
      <CardContent className="space-y-3 py-4">
        <div className="flex items-start gap-2">
          <Tag
            className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="space-y-1">
            <p className="text-sm font-medium">{headline}</p>
            <p className="text-sm text-muted-foreground">{verdict.guidance}</p>
            <p className="text-xs text-muted-foreground">
              The maker drives the grade, the comp search and the size chart. All
              three fall back to a generic answer without it.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="brand-real-maker" className="text-xs">
              Maker on the neck or care tag
            </Label>
            <Input
              id="brand-real-maker"
              value={maker}
              onChange={(e) => setMaker(e.target.value)}
              placeholder="Gildan, Hanes, Delta..."
              disabled={disabled || busy}
            />
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              onClick={() => void record(maker.trim())}
              disabled={disabled || busy || maker.trim() === ""}
            >
              Save maker
            </Button>
            {/* The eBay-shipped value, offered explicitly so "no label" never has
                to be typed as "none" or left blank and guessed at later. */}
            <Button
              type="button"
              variant="outline"
              onClick={() => void record("Unbranded")}
              disabled={disabled || busy}
            >
              No label
            </Button>
          </div>
        </div>

        {verdict.class !== "blank" && verdict.class !== "unknown" && (
          <p className="text-xs text-muted-foreground">
            Keep <span className="text-foreground">{verdict.value}</span> as a
            listing keyword by putting it in Theme or Style below. It is worth
            searching on; it just is not who made the garment.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
