// US-2968: the ready-made listing templates a new seller can start from.
//
// `/dashboard/flipdesk/templates` opened on "No templates yet" and a button
// that asked the seller to build a preset before they had seen one. These four
// are the shapes a reseller's inventory actually falls into, written out.
//
// WHAT IS IN THEM, AND WHAT DELIBERATELY IS NOT. Each carries a name, a
// description footer, a default eBay condition and a condition note. None
// carries `item_specifics` or a shipping / payment / return policy id: those
// are ids from the seller's own eBay account, so a starter that guessed them
// would be wrong for every single person who installed it.
//
// THE FOOTER IS A FOOTER. `description_template` appends — that is what the
// column has been for since migration 00105, and since US-2967 it lands as its
// own description block rather than being folded over the AI's prose. So the
// copy below reads as terms after a listing, never as the listing itself: no
// brand, no size, no colour, and no {{placeholders}}, all of which the blocks
// above it already say.
//
// `src/lib/starter-templates.test.ts` enforces every rule in this comment.

import type { StarterPreset } from "@/lib/starter-presets";
import { APPAREL_CONDITION_LABELS, EBAY_CONDITION_ENUM_TO_ID } from "@/lib/constants";

/**
 * The picker's condition line, built from the value so the two cannot drift.
 * Apparel labels, because every starter is apparel: USED_EXCELLENT (3000) is
 * "Pre-owned - Good" to a clothing buyer, which is what the old hand-typed
 * "Excellent" note got wrong.
 */
export function conditionLine(ebayCondition: string): string {
  const id = EBAY_CONDITION_ENUM_TO_ID[ebayCondition];
  const label = id ? APPAREL_CONDITION_LABELS[id] : undefined;
  return `Condition: ${label ?? ebayCondition}`;
}

/** What the picker needs on top of the shared preset shape. */
export interface StarterTemplate extends StarterPreset {
  ebayCondition: string;
  conditionDescription: string;
}

/** What the picker lists under a starter: the condition and the note it saves. */
function details(ebayCondition: string, conditionDescription: string) {
  return [
    { label: "Condition", value: conditionLine(ebayCondition).replace(/^Condition: /, "") },
    { label: "Condition note", value: conditionDescription },
  ];
}

const STARTERS: ReadonlyArray<Omit<StarterTemplate, "details">> = [
  {
    id: "everyday-basics",
    name: "Everyday basics",
    ebayCondition: "PRE_OWNED_EXCELLENT",
    conditionDescription:
      "Worn a handful of times. No holes, stains or pilling, and the print and seams are intact.",
    body:
      "Ships within one business day, tracked, from a smoke-free home.\n\n" +
      "Returns accepted for 30 days. Send it back the way it arrived and I " +
      "refund the item price.\n\n" +
      "Buying more than one? Bundle them and I will send you a discounted offer.",
    note: conditionLine("PRE_OWNED_EXCELLENT"),
  },
  {
    id: "vintage-and-thrifted",
    name: "Vintage and thrifted",
    ebayCondition: "USED_EXCELLENT",
    conditionDescription:
      "Honest vintage wear consistent with its age. Anything worth knowing about is photographed and listed above.",
    body:
      "This is a vintage piece, so read it as one. Older tags do not mean what " +
      "the same number means today. Compare the numbers listed above to " +
      "something already in your closet rather than trusting the size on the " +
      "label.\n\n" +
      "Everything I can see is photographed and written down. Message me " +
      "before you buy if you want another angle and I will send it the same " +
      "day.\n\n" +
      "Ships in one business day, tracked, from a smoke-free home.",
    note: conditionLine("USED_EXCELLENT"),
  },
  {
    id: "designer-and-luxury",
    name: "Designer and luxury",
    ebayCondition: "PRE_OWNED_EXCELLENT",
    conditionDescription:
      "Excellent pre-owned condition. Hardware, lining and stitching all photographed above.",
    body:
      "Sourced and inspected in person. Every tag, stamp and piece of hardware " +
      "is photographed above so you can check it yourself before you buy.\n\n" +
      "Ships within one business day, insured, signature on delivery, packed " +
      "in a box rather than a mailer.\n\n" +
      "Returns accepted for 30 days as long as the tags are still attached.",
    note: conditionLine("PRE_OWNED_EXCELLENT"),
  },
  {
    id: "kids-and-baby",
    name: "Kids and baby",
    ebayCondition: "USED_EXCELLENT",
    conditionDescription:
      "Gently used with normal play wear. Washed and checked for holes, stains and working snaps before listing.",
    body:
      "Washed before it was listed and washed again before it ships. Snaps, " +
      "zips and elastic all checked.\n\n" +
      "Kids clothes are cheaper by the pile: add anything else from my shop to " +
      "a bundle and I will send a discounted offer for the lot in one box.\n\n" +
      "Ships in one business day from a smoke-free, pet-free home.",
    note: conditionLine("USED_EXCELLENT"),
  },
]

export const STARTER_TEMPLATES: readonly StarterTemplate[] = Object.freeze(
  STARTERS.map((t) => ({ ...t, details: details(t.ebayCondition, t.conditionDescription) })),
);
