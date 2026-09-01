// eBay standardized size enforcement: the pure half of the self-heal.
//
//   deno test src/tests/ebay-size-enforcement_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  parseCustomValueRejection,
  reconcileSpecsFromPayload,
  refitAspectsAfterRejection,
  sizeEnforcementMessage,
} from "../lib/ebay-size-enforcement.ts";

const EBAY_MESSAGE =
  "The product aspects for this category no longer support custom values for Size Type. Your listing was not published. Update your request to use our standard values for Size Type. Use getItemAspectsForCategory for your marketplace and leaf category to get the standard values for Size Type.";

Deno.test("the rejected aspect is read off eBay's message, once", () => {
  assertEquals(parseCustomValueRejection([EBAY_MESSAGE]), ["Size Type"]);
  assertEquals(
    parseCustomValueRejection([EBAY_MESSAGE, "no longer support custom values for Size."]),
    ["Size Type", "Size"],
  );
  assertEquals(parseCustomValueRejection(["The item specific Inseam is missing."]), []);
  assertEquals(parseCustomValueRejection([]), []);
});

// What the fresh Taxonomy payload says after eBay closed the list. Note the
// mode is STILL "SUGGESTED" in this fixture: the enforcement rides the name.
const FRESH = {
  aspects: [
    {
      localizedAspectName: "Size Type",
      aspectConstraint: { aspectMode: "SUGGESTED", aspectDataType: "STRING" },
      aspectValues: [
        { localizedValue: "Regular" },
        { localizedValue: "Plus" },
        { localizedValue: "Petite" },
        { localizedValue: "Big & Tall" },
        { localizedValue: "Juniors" },
        { localizedValue: "Maternity" },
      ],
    },
    {
      localizedAspectName: "Size",
      aspectConstraint: { aspectMode: "SUGGESTED", aspectDataType: "STRING" },
      aspectValues: [
        { localizedValue: "XS" },
        { localizedValue: "S" },
        { localizedValue: "M" },
        { localizedValue: "L" },
        { localizedValue: "XL" },
      ],
    },
    {
      localizedAspectName: "Color",
      aspectConstraint: { aspectMode: "FREE_TEXT", aspectDataType: "STRING" },
      aspectValues: [{ localizedValue: "Black" }],
    },
  ],
};

Deno.test("a synonym is repaired to the standard value and reported as a change", () => {
  const specs = reconcileSpecsFromPayload(FRESH);
  const r = refitAspectsAfterRejection(
    { "Size Type": ["Standard"], Size: ["Large"], Color: ["Taupe"] },
    specs,
    ["Size Type"],
  );
  assertEquals(r.aspects["Size Type"], ["Regular"]);
  assertEquals(r.aspects["Size"], ["L"], "Size is a closed list too, whatever the cached mode");
  assertEquals(r.aspects["Color"], ["Taupe"], "free text stays free text");
  assertEquals(r.changed, [{ aspect: "Size Type", from: ["Standard"], to: ["Regular"] }]);
  assertEquals(r.unresolved, []);
  assert(/changed "Standard" to "Regular"/.test(sizeEnforcementMessage(r)));
});

Deno.test("a value that matches nothing is omitted and the seller is told what to pick", () => {
  const specs = reconcileSpecsFromPayload(FRESH);
  const r = refitAspectsAfterRejection({ "Size Type": ["Misses"], Size: ["L"] }, specs, ["Size Type"]);
  assertEquals(r.aspects["Size Type"], undefined);
  assertEquals(r.changed, []);
  assertEquals(r.unresolved.length, 1);
  assertEquals(r.unresolved[0]?.value, "Misses");
  assertEquals(r.unresolved[0]?.allowedCount, 6);
  const msg = sizeEnforcementMessage(r);
  assert(/"Misses" is not one of them/.test(msg));
  assert(/Regular, Plus, Petite/.test(msg));
});

Deno.test("a value that already matches is neither changed nor unresolved", () => {
  const specs = reconcileSpecsFromPayload(FRESH);
  const r = refitAspectsAfterRejection({ "Size Type": ["Regular"] }, specs, ["Size Type"]);
  assertEquals(r.changed, []);
  assertEquals(r.unresolved, []);
});
