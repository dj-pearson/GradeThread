// US-2134 AC1: the clothing authenticity macros are only offered to a seller who
// can actually use them.
//
// `serial` and `marking` carry two different meanings and the filter has to
// respect both. On a watch or a handbag the reference number and the hallmark
// are core CONDITION evidence — several of those profiles mark them required —
// so they are never stripped. On clothing they are authenticity extras that the
// condition grade does not read, and every clothing seller was being asked to
// "fill the frame with the date code" whether or not the add-on existed for
// them.
//
// The eligible path returns the SAME OBJECT, which is what makes "we changed
// nothing for sellers who have the add-on" checkable instead of asserted.

import "./_env.ts";
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  applyAuthenticityMacroVisibility,
  AUTHENTICITY_MACRO_TYPES,
  getPhotoProfile,
  PHOTO_PROFILES,
  requiredPhotoTypesFor,
} from "../lib/photo-profiles.ts";

const hasMacro = (p: { roles: Array<{ type: string }> }) =>
  p.roles.some((r) => (AUTHENTICITY_MACRO_TYPES as readonly string[]).includes(r.type));

Deno.test("US-2134: an eligible seller gets the byte-identical profile", () => {
  for (const profile of Object.values(PHOTO_PROFILES)) {
    assertStrictEquals(
      applyAuthenticityMacroVisibility(profile, true),
      profile,
      `${profile.category} must be the same object when eligible`,
    );
  }
});

Deno.test("US-2134: an ineligible seller loses the macros on CLOTHING only", () => {
  const shirt = getPhotoProfile("clothing", "t-shirt");
  assert(hasMacro(shirt), "precondition: clothing offers the macros today");
  const filtered = applyAuthenticityMacroVisibility(shirt, false);
  assert(!hasMacro(filtered), "clothing must lose serial/marking when ineligible");
  // Nothing else moved: same order, same everything, two fewer entries.
  assertEquals(filtered.category, shirt.category);
  assertEquals(filtered.roles.length, shirt.roles.length - 2);
  assertEquals(
    filtered.roles.map((r) => r.type),
    shirt.roles.map((r) => r.type).filter((t) =>
      !(AUTHENTICITY_MACRO_TYPES as readonly string[]).includes(t)
    ),
  );
});

Deno.test("US-2134: a watch or handbag KEEPS its serial and hallmark when ineligible", () => {
  // The story's own framing is that these slots were non-clothing-only to begin
  // with. Stripping them here would delete real condition evidence — a watch
  // with no reference number is under-photographed whatever anyone bought.
  // Named rather than derived by "not clothing": the clothing sub-profiles are
  // keyed `clothing:top`, `clothing:dress` and so on, so a `!== "clothing"`
  // filter sweeps five clothing profiles into this case and fails against
  // correct code. Which is exactly what it did on the first run.
  const NON_CLOTHING_WITH_MACROS = [
    "watches",
    "jewelry",
    "collectibles",
    "electronics",
    "bags",
  ];
  const nonClothing = NON_CLOTHING_WITH_MACROS.map((k) => {
    const p = PHOTO_PROFILES[k];
    assert(p, `${k} profile is gone — update this list rather than dropping the case`);
    assert(hasMacro(p), `precondition: ${k} still uses serial/marking`);
    return p;
  });
  for (const p of nonClothing) {
    assertStrictEquals(
      applyAuthenticityMacroVisibility(p, false),
      p,
      `${p.category} must keep serial/marking — they are condition evidence there`,
    );
  }
});

Deno.test("US-2134 AC2: hiding a macro cannot change what a grade REQUIRES", () => {
  // A condition grade must never fail because an authenticity slot was skipped.
  // The macros are optional, so the required set is the same either way — and
  // this is the assertion that fails if someone later marks one required.
  for (const p of Object.values(PHOTO_PROFILES)) {
    for (const r of p.roles) {
      if ((AUTHENTICITY_MACRO_TYPES as readonly string[]).includes(r.type)) {
        if (p.category === "clothing" || p.category.startsWith("clothing")) {
          assert(
            !r.required,
            `${p.category}'s ${r.type} slot is required — a hidden slot would ` +
              "then block a condition grade, which AC2 forbids",
          );
        }
      }
    }
  }
  const before = requiredPhotoTypesFor("clothing", "t-shirt");
  for (const t of before) {
    assert(
      !(AUTHENTICITY_MACRO_TYPES as readonly string[]).includes(t),
      `${t} is in the clothing required set; hiding it would block the gate`,
    );
  }
});

Deno.test("US-2134: the entitlement is resolved for the WORKSPACE OWNER, not the camera holder", async () => {
  // Found by the tenant-isolation audit: the route reads
  // `workspaceOwnerId ?? userId`, and that first half is DEAD unless
  // workspaceMiddleware runs on this path. Only authMiddleware was mounted.
  //
  // The consequence is the opposite of a leak and still wrong: a member
  // capturing photos inside owner A's paid workspace would be judged on their
  // own usually-free plan, and lose the two slots A paid for. `authenticity_addon`
  // is plan-targetable, so that is a live path rather than a hypothetical.
  //
  // Asserted on the MOUNT rather than on the route file, because the route's
  // expression is already correct — what was missing is the middleware that
  // makes it mean anything.
  const main = await Deno.readTextFile(new URL("../main.ts", import.meta.url));
  assert(
    /app\.use\(\s*"\/api\/flipdesk\/photo-profiles\/\*"\s*,\s*workspaceMiddleware\s*\)/
      .test(main),
    "photo-profiles must mount workspaceMiddleware, or workspaceOwnerId is undefined " +
      "and the route silently resolves the wrong account's entitlement",
  );
  const route = await Deno.readTextFile(
    new URL("../routes/flipdesk-photo-profiles.ts", import.meta.url),
  );
  assert(
    route.includes('c.get("workspaceOwnerId") ?? c.get("userId")'),
    "the route must prefer the workspace owner",
  );
});

Deno.test("US-2134: every clothing sub-profile is covered, not just the one I checked", () => {
  // The tail is shared, so a filter that worked on t-shirts but missed
  // outerwear would be invisible in a single-case test.
  const garments = ["t-shirt", "blazer", "jeans", "dress", "coat", "skirt"];
  for (const g of garments) {
    const p = getPhotoProfile("clothing", g);
    assert(hasMacro(p), `precondition: ${g} offers the macros`);
    assert(
      !hasMacro(applyAuthenticityMacroVisibility(p, false)),
      `${g} still offers an authenticity macro to an ineligible seller`,
    );
  }
});
