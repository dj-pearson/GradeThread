// US-2966: the ready-made description snippets a new seller can start from.
//
// `/dashboard/flipdesk/description-snippets` used to open on an empty page and
// a button that said "Write your first snippet", which asks the seller to know
// what a snippet is for before they have seen one. These nine are the lines
// resellers actually repeat, written out, so the first click produces something
// to edit rather than a cursor in an empty box.
//
// TWO RULES the copy has to keep, both from the block epic (US-2965):
//
//   * No {{placeholders}}. A snippet body is rendered verbatim — nothing
//     interpolates it — so a placeholder would ship to a buyer as literal
//     braces.
//   * Nothing that restates the measurements or the grade. Both are their own
//     description blocks now, rendered from the item, and a snippet repeating
//     them prints the fact twice: once from the block, which follows the
//     seller's next edit, and once from here, which does not.
//
// `src/lib/starter-snippets.test.ts` enforces both, plus the length caps.

import type { StarterPreset } from "@/lib/starter-presets";

export const STARTER_SNIPPETS: readonly StarterPreset[] = Object.freeze([
  {
    id: "ships-fast",
    name: "Ships fast",
    body:
      "Ordered before 2pm on a weekday? It goes out the same day. Everything " +
      "ships with tracking, and you get the number as soon as the label prints.",
  },
  {
    id: "returns",
    name: "Returns",
    body:
      "Returns accepted within 30 days. Send it back the way it arrived and I " +
      "refund the item price as soon as it lands. No restocking fee, no " +
      "questions I have to be talked into.",
  },
  {
    id: "bundle-and-save",
    name: "Bundle and save",
    body:
      "Buying more than one? Add them to a bundle and I will send you a " +
      "discounted offer before you check out. Two or more usually ships in one " +
      "box, and you keep the difference.",
  },
  {
    id: "offers-welcome",
    name: "Offers welcome",
    body:
      "Send an offer. I answer the same day, and if it is anywhere close I " +
      "will meet you in the middle rather than let it sit.",
  },
  {
    id: "smoke-free-home",
    name: "Smoke-free home",
    body: "Stored, packed and shipped from a smoke-free and pet-free home.",
  },
  {
    id: "vintage-sizing",
    name: "Vintage sizing",
    body:
      "Older tags do not mean what the same number means today, and sizing " +
      "moved again in the 1990s. Check the numbers listed above against " +
      "something already in your closet before you buy.",
  },
  {
    id: "how-it-is-packed",
    name: "How it is packed",
    body:
      "Folded, wrapped in tissue and sealed in a poly mailer. Nothing goes out " +
      "loose in a box, and nothing goes out damp.",
  },
  {
    id: "questions-welcome",
    name: "Questions welcome",
    body:
      "Message me before you buy. I answer the same day and I am happy to send " +
      "extra photos of anything the listing does not show well.",
  },
  {
    id: "thanks-and-feedback",
    name: "Thanks and feedback",
    body:
      "Thanks for buying from a small shop instead of a warehouse. If it " +
      "arrived the way you expected, feedback helps more than you would think.",
  },
]);
