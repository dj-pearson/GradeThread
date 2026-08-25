import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { lookupTerm, type ProductTermName } from "@/lib/product-terms";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";

// US-2864. The in-product definition for one invented word.
//
// A dotted underline rather than a link colour: the word is not a destination,
// and a reader who already knows what a Comp is should be able to read straight
// past it. It is a real <button>, so it opens on Enter and on Space and is
// announced as something you can act on -- a <span> with a hover card is
// invisible to anyone not using a mouse, which is most of the people who do not
// already know the word.

interface TermProps {
  /** Typed against PRODUCT_TERMS, so a typo is a build error. */
  name: ProductTermName;
  /**
   * What to render. Defaults to the term itself; pass children when the
   * sentence needs a different case or a plural ("comps", "Passports").
   */
  children?: React.ReactNode;
  className?: string;
}

export function Term({ name, children, className }: TermProps) {
  const entry = lookupTerm(name);
  // A word with no entry renders as plain text rather than as a dead control.
  // Same rule as HelpLink: degrade to the product you already had.
  if (!entry) return <>{children ?? name}</>;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={() => track("help_term_open", { term: entry.term })}
          className={cn(
            "cursor-help underline decoration-dotted decoration-from-font underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
          aria-label={`What ${entry.term} means`}
        >
          {children ?? entry.term}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 text-sm">
        <p className="font-semibold">{entry.term}</p>
        <p className="mt-1 text-muted-foreground">{entry.definition}</p>
        <div className="mt-3 flex items-center justify-between gap-2 text-xs">
          {entry.to ? (
            <Link
              to={entry.to}
              className="inline-flex items-center font-medium text-primary hover:underline"
            >
              Open it
              <ArrowRight className="ml-1 h-3 w-3" />
            </Link>
          ) : (
            <span />
          )}
          <Link
            to="/dashboard/help/glossary"
            className="text-muted-foreground hover:underline"
          >
            All terms
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
