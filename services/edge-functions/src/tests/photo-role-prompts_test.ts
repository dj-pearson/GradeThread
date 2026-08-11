// US-2471: the grading prompts speak in ROLES, behind a default-off gate.
//
// The whole claim of this story is that deploying it changes no grade until an
// operator turns GRADING_PHOTO_ROLES on. That claim is only worth as much as the
// test below, so this file flips the REAL env var rather than threading a
// boolean — a version of this test that passed a parameter would pass while the
// deployed default did something else (the same reasoning as
// category-criteria_test.ts, which is the precedent this follows).

import "./_env.ts"; // US-2379: must come first — ai-grading reaches lib/supabase.ts
import { assert, assertEquals } from "@std/assert";
import {
  buildUserPrompt,
  imageRoleContextFor,
  photoRolePromptsEnabled,
  promptVersionSuffix,
} from "../lib/ai-grading.ts";
import { selectAuthenticityImages } from "../lib/ai-authenticity.ts";
import { photoSlotLabel } from "../lib/ai-extract.ts";

/** Assemble a prompt for a (type, role) pair with the gate in a known state. */
function prompt(
  imageType: string,
  imageRole: string | null,
  enabled: boolean,
): string {
  const prev = Deno.env.get("GRADING_PHOTO_ROLES");
  if (enabled) Deno.env.set("GRADING_PHOTO_ROLES", "true");
  else Deno.env.delete("GRADING_PHOTO_ROLES");
  try {
    return buildUserPrompt(
      imageType,
      "tops",
      "t-shirt",
      [],
      "",
      {},
      imageRole,
    );
  } finally {
    if (prev === undefined) Deno.env.delete("GRADING_PHOTO_ROLES");
    else Deno.env.set("GRADING_PHOTO_ROLES", prev);
  }
}

// Every (type, role) pair the vocabulary can actually produce for a grading
// image_type. `tag` becomes `label` on the way in (mapPhotoTypeForGrading).
const ROLE_PAIRS: [string, string][] = [
  ["label", "brand"],
  ["label", "size"],
  ["label", "size_alt"],
  ["label", "care"],
  ["label", "made_in"],
  ["detail", "fabric"],
  ["detail", "hem"],
  ["detail", "hardware"],
  ["detail", "pocket"],
  ["detail", "print"],
  ["detail", "collar"],
  ["detail", "handles"],
  ["detail", "base"],
  ["detail", "ends_edges"],
  ["detail", "insole"],
];

Deno.test("US-2471: the gate is OFF unless someone sets it", () => {
  const prev = Deno.env.get("GRADING_PHOTO_ROLES");
  Deno.env.delete("GRADING_PHOTO_ROLES");
  try {
    assertEquals(photoRolePromptsEnabled(), false);
    Deno.env.set("GRADING_PHOTO_ROLES", "yes");
    assertEquals(
      photoRolePromptsEnabled(),
      false,
      "fail closed: only 1/true turn a grading prompt on",
    );
    Deno.env.set("GRADING_PHOTO_ROLES", "1");
    assertEquals(photoRolePromptsEnabled(), true);
  } finally {
    if (prev === undefined) Deno.env.delete("GRADING_PHOTO_ROLES");
    else Deno.env.set("GRADING_PHOTO_ROLES", prev);
  }
});

Deno.test("US-2471: with the gate OFF every prompt is byte-identical", () => {
  for (const [type, role] of ROLE_PAIRS) {
    assertEquals(
      prompt(type, role, false),
      prompt(type, null, false),
      `the ${type}:${role} prompt moved with GRADING_PHOTO_ROLES off — this ` +
        `commit must change no grade until an operator turns it on`,
    );
  }
  // And a type that takes no qualifier never moves, gate on or off.
  assertEquals(prompt("front", null, true), prompt("front", null, false));
  assertEquals(prompt("defect", null, true), prompt("defect", null, false));
});

Deno.test("US-2471: with the gate ON every role changes its own prompt", () => {
  for (const [type, role] of ROLE_PAIRS) {
    const withRole = prompt(type, role, true);
    assert(
      withRole !== prompt(type, null, true),
      `${type}:${role} produced the bare-type prompt — the role reached the ` +
        `prompt site and said nothing`,
    );
    assert(
      withRole.includes("IMAGE CONTEXT:"),
      "the role sentence must render in the IMAGE CONTEXT slot, not a new one",
    );
  }
});

Deno.test("US-2471: an unknown role falls through to the bare type", () => {
  // A role that ships in photo-roles.ts before it has a sentence here must NOT
  // blank the context out. Falling through is the safe direction.
  assertEquals(prompt("detail", "not_a_real_role", true), prompt("detail", null, true));
  assertEquals(imageRoleContextFor("detail", "not_a_real_role", true), undefined);
  assertEquals(imageRoleContextFor("detail", "fabric", false), undefined);
  assertEquals(imageRoleContextFor("detail", null, true), undefined);
});

Deno.test("US-2471: the +roles suffix appends LAST and is absent when off", () => {
  const all = {
    baseline: true,
    fabric: true,
    visual: true,
    tag: true,
    categoryV2: true,
  };
  assertEquals(promptVersionSuffix(all), "+baseline+fabric+visual+tag+cat2");
  assertEquals(
    promptVersionSuffix({ ...all, roles: true }),
    "+baseline+fabric+visual+tag+cat2+roles",
    "+roles must append after +cat2 — inserting a suffix in the middle " +
      "rewrites what every previously recorded version string means",
  );
  assertEquals(
    promptVersionSuffix({
      baseline: false,
      fabric: false,
      visual: false,
      tag: false,
      roles: false,
    }),
    "",
  );
});

Deno.test("US-2471: a role promotes a close-up, but not past serial/marking", () => {
  const imgs = [
    { imageType: "front" },
    { imageType: "detail", imageRole: "pocket" },
    { imageType: "detail", imageRole: "hardware" },
    { imageType: "label" },
    { imageType: "serial" },
  ];
  const picked = selectAuthenticityImages(imgs, true).map((i) =>
    `${i.imageType}:${i.imageRole ?? ""}`
  );
  assertEquals(picked[0], "serial:", "US-2134 put serial first, and it stays first");
  assertEquals(picked[1], "label:", "a hardware macro must not displace the label");
  assertEquals(picked[2], "detail:hardware");
  assertEquals(
    picked[3],
    "detail:pocket",
    "a condition-shot role stays at the bare-detail rank",
  );

  // Gate off → the pre-role ordering, which knows nothing about roles and so
  // keeps the two details in input order.
  const off = selectAuthenticityImages(imgs, false).map((i) => i.imageType);
  assertEquals(off, ["serial", "label", "detail", "detail", "front"]);
});

Deno.test("US-2471: ai-extract announces which tag is which", () => {
  // Unqualified photos read exactly as they did before roles existed.
  assertEquals(photoSlotLabel({ url: "u" }), "");
  assertEquals(photoSlotLabel({ url: "u", type: "tag" }), " (tag)");
  // Qualified ones name the label, which is the whole of AC4.
  assertEquals(photoSlotLabel({ url: "u", type: "tag", role: "brand" }), " (tag: brand label)");
  assertEquals(photoSlotLabel({ url: "u", type: "tag", role: "size" }), " (tag: size tag)");
  assertEquals(
    photoSlotLabel({ url: "u", type: "detail", role: "fabric" }),
    " (detail: fabric close-up)",
  );
  // An unknown role still says something rather than swallowing itself.
  assertEquals(photoSlotLabel({ url: "u", type: "tag", role: "mystery" }), " (tag: mystery)");
});
