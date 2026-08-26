// US-2886: "Sourced by" is a roster pick, not free text.
//
// The two things that would quietly ruin the field are covered here: an
// existing name disappearing from an old item because it predates the roster,
// and the signed-in person having to hunt for themselves in an alphabetical
// list. Plus a source scan proving no FlipDesk surface still types the name
// into a bare text box.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { toSourcerOptions } from "@/hooks/use-sourcers";
import { offRosterName } from "@/components/flipdesk/sourced-by-select";
import type { SourcerRow } from "@/types/database";

const ME = "11111111-1111-1111-1111-111111111111";
const TEAMMATE = "22222222-2222-2222-2222-222222222222";

function row(over: Partial<SourcerRow> & { id: string; name: string }): SourcerRow {
  return {
    user_id: "owner",
    member_user_id: null,
    archived_at: null,
    created_at: "2026-08-25T00:00:00Z",
    updated_at: "2026-08-25T00:00:00Z",
    ...over,
  };
}

describe("toSourcerOptions", () => {
  it("puts the signed-in person first, then sorts the rest by name", () => {
    const options = toSourcerOptions(
      [
        row({ id: "a", name: "Aaron" }),
        row({ id: "d", name: "Dan", member_user_id: ME }),
        row({ id: "t", name: "Tiff" }),
        row({ id: "b", name: "Bev", member_user_id: TEAMMATE }),
      ],
      ME,
    );
    expect(options.map((o) => o.name)).toEqual(["Dan", "Aaron", "Bev", "Tiff"]);
    expect(options[0]?.isYou).toBe(true);
  });

  it("marks nobody as 'you' when signed out", () => {
    const options = toSourcerOptions(
      [row({ id: "d", name: "Dan", member_user_id: ME })],
      null,
    );
    expect(options[0]?.isYou).toBe(false);
  });

  it("keeps a linked teammate distinguishable from a hand-added person", () => {
    const options = toSourcerOptions(
      [
        row({ id: "b", name: "Bev", member_user_id: TEAMMATE }),
        row({ id: "t", name: "Tiff" }),
      ],
      ME,
    );
    expect(options.find((o) => o.name === "Bev")?.memberUserId).toBe(TEAMMATE);
    expect(options.find((o) => o.name === "Tiff")?.memberUserId).toBeNull();
  });
});

describe("offRosterName", () => {
  const roster = [{ name: "Dan" }, { name: "Tiff" }];

  it("surfaces a legacy name so an old item does not open blank", () => {
    expect(offRosterName("Spouse", roster)).toBe("Spouse");
  });

  it("matches the roster case-insensitively, the way the unique index does", () => {
    expect(offRosterName("dan", roster)).toBeNull();
    expect(offRosterName("  TIFF  ", roster)).toBeNull();
  });

  it("returns null for an unset field", () => {
    expect(offRosterName("", roster)).toBeNull();
    expect(offRosterName("   ", roster)).toBeNull();
  });
});

describe("every FlipDesk sourcing surface uses the picker", () => {
  const SURFACES = [
    "src/pages/flipdesk/intake.tsx",
    "src/components/flipdesk/bulk-intake.tsx",
    "src/components/flipdesk/snap-catalog.tsx",
    "src/components/flipdesk/composer/item-details-card.tsx",
  ];

  it.each(SURFACES)("%s renders SourcedBySelect", (rel) => {
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    expect(src).toContain("SourcedBySelect");
  });

  it.each(SURFACES)("%s has no bare text input for the name", (rel) => {
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    // The old shape: an <Input> whose id or handler named sourced-by/sourcedBy.
    expect(src).not.toMatch(/<Input[^>]*id="[^"]*sourced-by"/);
    expect(src).not.toMatch(/setSourcedBy\(e\.target\.value\)/);
  });
});
