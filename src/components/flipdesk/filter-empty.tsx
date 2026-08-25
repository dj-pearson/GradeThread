import { EmptyState } from "@/components/ui/empty-state";

// US-2867. The "your filter is hiding everything" state, in one place.
//
// It is a DIFFERENT state from "you have none of these yet", and the two were
// routinely written as the same short sentence. The distinction matters both
// ways: telling a seller with two hundred live listings to go and publish one
// is wrong, and offering "clear filters" to somebody who genuinely has nothing
// is a button that cannot help.
//
// The COUNT is a required prop rather than a sentence each caller writes,
// because "none match" reads as "you have none" unless the number is on screen,
// and that is the whole confusion this component exists to prevent.
//
// There is no primary action on purpose. On a filtered-empty list there is no
// "create one" worth offering -- the rows already exist -- so the only thing to
// press is the way back out.
export function FilterEmpty({
  noun,
  total,
  clearLabel,
  onClear,
}: {
  /** Singular, lowercase: "draft", "group", "listing". */
  noun: string;
  /** How many rows exist BEFORE the filter. */
  total: number;
  clearLabel: string;
  /**
   * Must reset EVERY filter. Half a reset leaves the list empty and makes the
   * button look broken, which is worse than not offering one.
   */
  onClear: () => void;
}) {
  const plural = total === 1 ? noun : `${noun}s`;
  return (
    <EmptyState
      title={`No ${noun}s match this filter`}
      description={`You have ${total} ${plural}. None of them match what you have selected.`}
      secondaryAction={{ label: clearLabel, onClick: onClear }}
    />
  );
}
