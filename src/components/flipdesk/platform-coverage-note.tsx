import { useState } from "react";
import { Link } from "react-router";
import { ChevronDown, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  coverageFor,
  joinLabels,
  type CoverageFeature,
} from "@/lib/marketplace-coverage";

// US-2541: says which marketplaces the surface below it actually reads.
//
// The point is the FIRST line, which a seller reads without clicking: "Offers
// here are eBay only." An empty list then means what it says. The per-platform
// reasons are folded away because they are reference, not news — but they are
// there, because "why not Poshmark" is the immediate next question and the
// answer is not "we could not be bothered".

export function PlatformCoverageNote({
  feature,
  noun,
  className,
}: {
  feature: CoverageFeature;
  /** What this surface shows, e.g. "Offers and buyer messages". */
  noun: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const { covered, uncovered } = coverageFor(feature);

  return (
    <div
      className={cn(
        "rounded-lg border bg-muted/30 px-3 py-2 text-sm",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p>
            {noun} here come from <strong>{joinLabels(covered)}</strong> only.
            {uncovered.length > 0 && " Your other channels are not read here."}
          </p>
          {uncovered.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Why not the other {uncovered.length}?
                <ChevronDown
                  className={cn(
                    "h-3 w-3 transition-transform",
                    open && "rotate-180",
                  )}
                />
              </button>
              {open && (
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {uncovered.map((p) => (
                    <li key={p.id}>
                      <span className="font-medium text-foreground">
                        {p.label}
                      </span>
                      {" — "}
                      {p.reason}
                    </li>
                  ))}
                  <li className="pt-1">
                    <Link
                      to="/dashboard/flipdesk/marketplaces"
                      className="underline underline-offset-2 hover:text-foreground"
                    >
                      What each connection can and cannot do
                    </Link>
                  </li>
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
