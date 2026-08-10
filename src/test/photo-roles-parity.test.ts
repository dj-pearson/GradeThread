// US-2463: the photo role vocabulary is one definition in two files.
//
// Same guard, and same reasoning, as src/test/measurement-template-parity.test.ts
// (US-2225). The failure mode here is quieter than a crash: `photo_role` is open
// text with no CHECK constraint — that is the whole point of the design — so if
// the web writes `made_in` and the edge profile builder emits `madeIn`, nothing
// errors anywhere. The photo saves, the picker shows an unlabelled slot, and the
// grading fabric check silently stops matching.
//
// The two files are meant to be the SAME file, so byte equality is the real
// contract. The one licensed difference is Deno's required import extension,
// normalised below; everything else must match exactly.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  DETAIL_ROLES,
  RETIRED_PHOTO_TYPES,
  TAG_ROLES,
  isRetiredPhotoType,
  measurementRolesFor,
  roleLabel,
  rolesForType,
  typeTakesRole,
} from "../lib/photo-roles";
import { MEASUREMENT_TEMPLATES } from "../lib/measurement-templates";

const WEB = "src/lib/photo-roles.ts";
const EDGE = "services/edge-functions/src/lib/photo-roles.ts";

function normalized(path: string): string {
  return readFileSync(path, "utf8")
    .split("\r\n")
    .join("\n")
    // Deno needs the extension on a local import; the web build must not have
    // it. This is the ONLY difference the two copies are allowed.
    .replace('from "./measurement-templates.ts";', 'from "./measurement-templates";');
}

describe("US-2463: the role vocabulary is one definition in two files", () => {
  it("the web and edge copies are identical apart from the Deno import", () => {
    expect(normalized(EDGE)).toBe(normalized(WEB));
  });
});

describe("US-2463 AC1/AC2: the tag and detail vocabularies", () => {
  it("splits a garment's labels into the four things they actually are", () => {
    expect(TAG_ROLES.map((r) => r.key)).toEqual(["brand", "size", "care", "made_in"]);
  });

  it("offers the made-in label vintage sellers date a piece by", () => {
    // The one genuinely new idea: before this there was no slot for a union
    // label or an RN number, so it got filed under "Garment Tag 2".
    const madeIn = TAG_ROLES.find((r) => r.key === "made_in");
    expect(madeIn).toBeDefined();
    expect(madeIn!.hint.toLowerCase()).toContain("vintage");
  });

  it("names the six things a detail shot is actually of", () => {
    expect(DETAIL_ROLES.map((r) => r.key))
      .toEqual(["fabric", "hem", "hardware", "pocket", "print", "collar"]);
  });

  it("keeps every role key lowercase snake_case", () => {
    // These are written to open text with no CHECK constraint, so the shape is
    // enforced here or nowhere.
    for (const r of [...TAG_ROLES, ...DETAIL_ROLES]) {
      expect(r.key, r.key).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(r.label.length, r.key).toBeGreaterThan(0);
      expect(r.hint.length, r.key).toBeGreaterThan(0);
    }
  });
});

describe("US-2463 AC4: measurement roles are derived, not hand-listed", () => {
  it("mirrors the measurement template for every group, in order", () => {
    // The contract that makes a new measurement field get a photo slot for
    // free. If this ever needs a hand-maintained list, the derivation broke.
    for (const group of Object.keys(MEASUREMENT_TEMPLATES) as (keyof typeof MEASUREMENT_TEMPLATES)[]) {
      expect(measurementRolesFor(group).map((r) => r.key), group)
        .toEqual(MEASUREMENT_TEMPLATES[group].map((f) => f.key));
    }
  });

  it("never offers a top an inseam slot", () => {
    // The complaint that opened the epic, pinned.
    expect(measurementRolesFor("top").map((r) => r.key)).not.toContain("inseam");
    expect(measurementRolesFor("top").map((r) => r.key))
      .toEqual(["chest", "length", "shoulder", "sleeve"]);
  });

  it("gives a blazer a shoulder slot, which no fixed tag ever did", () => {
    expect(measurementRolesFor("outerwear").map((r) => r.key)).toContain("shoulder");
  });

  it("gives a suit set both halves in one item", () => {
    const keys = measurementRolesFor("suit").map((r) => r.key);
    expect(keys).toContain("chest");
    expect(keys).toContain("sleeve");
    expect(keys).toContain("waist");
    expect(keys).toContain("inseam");
  });

  it("gives every derived role a capture hint", () => {
    for (const group of Object.keys(MEASUREMENT_TEMPLATES) as (keyof typeof MEASUREMENT_TEMPLATES)[]) {
      for (const r of measurementRolesFor(group)) {
        expect(r.hint.length, `${group}.${r.key}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("US-2463: which types take a qualifier", () => {
  it("qualifies exactly tag, detail and measurement", () => {
    for (const t of ["tag", "detail", "measurement"]) {
      expect(typeTakesRole(t), t).toBe(true);
      expect(rolesForType(t, "top").length, t).toBeGreaterThan(0);
    }
    // `front` shows a front. There is nothing further to say about it.
    for (const t of ["front", "back", "defect", "flatlay", "on_model", "interior"]) {
      expect(typeTakesRole(t), t).toBe(false);
      expect(rolesForType(t, "top"), t).toEqual([]);
    }
  });

  it("labels a stored pair and returns null for anything unknown", () => {
    expect(roleLabel("tag", "size")).toBe("Size tag");
    expect(roleLabel("detail", "fabric")).toBe("Fabric close-up");
    expect(roleLabel("measurement", "inseam", "bottom")).toBe("Inseam");
    expect(roleLabel("tag", null)).toBeNull();
    expect(roleLabel("tag", "nonsense")).toBeNull();
    // A top has no inseam, so the pair is unlabelled rather than wrong.
    expect(roleLabel("measurement", "inseam", "top")).toBeNull();
  });
});

describe("US-2463: the retired types keep their meaning", () => {
  it("maps every retired type onto a (type, role) pair", () => {
    expect(Object.keys(RETIRED_PHOTO_TYPES).sort()).toEqual([
      "detail_2", "detail_3", "detail_4",
      "measurement_chest", "measurement_inseam", "measurement_length",
      "measurement_sleeve", "measurement_waist",
      "tag_2",
    ]);
    // The measurement ones carry their key across; the numbered ones do not
    // invent a role, because "Detail 3" never meant anything in particular.
    expect(RETIRED_PHOTO_TYPES.measurement_chest).toEqual({ type: "measurement", role: "chest" });
    expect(RETIRED_PHOTO_TYPES.detail_3).toEqual({ type: "detail", role: null });
    expect(RETIRED_PHOTO_TYPES.tag_2).toEqual({ type: "tag", role: null });
  });

  it("does not retire a type that is still a valid choice", () => {
    for (const t of ["tag", "detail", "measurement", "front", "back", "defect"]) {
      expect(isRetiredPhotoType(t), t).toBe(false);
    }
  });

  it("every retired measurement role exists on some template", () => {
    // Guards the backfill: a role the clients cannot label would render as a
    // blank slot on every historical photo.
    const all = new Set(
      Object.values(MEASUREMENT_TEMPLATES).flat().map((f) => f.key),
    );
    for (const [from, to] of Object.entries(RETIRED_PHOTO_TYPES)) {
      if (to.role) expect(all.has(to.role), from).toBe(true);
    }
  });
});
