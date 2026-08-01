import { Info } from "lucide-react";

// US-2169: the visible half of the row-cap contract.
//
// A capped read is fine. A capped read that LOOKS complete is not — a seller
// who prices, relists or sources against a list they cannot tell is cut short
// makes a decision on missing evidence and never learns why. So any surface
// using fetchCapped() renders this whenever `truncated` is true, and says the
// number out loud rather than trailing off.
//
// Deliberately not an alert: nothing is wrong, and dressing a normal cap as a
// warning teaches people to ignore real warnings on the same page.
export function TruncatedNotice({
  limit,
  noun,
  action,
}: {
  /** How many rows ARE shown. */
  limit: number;
  /** Plural noun for the rows, e.g. "drafts". */
  noun: string;
  /** What the seller can do about it, e.g. "Publish or clear some to see more." */
  action?: string;
}) {
  return (
    <p className="flex items-start gap-2 text-sm text-muted-foreground">
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        Showing the first {limit.toLocaleString()} {noun}. There are more.
        {action ? ` ${action}` : ""}
      </span>
    </p>
  );
}
