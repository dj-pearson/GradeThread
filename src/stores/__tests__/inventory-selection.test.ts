// INV-2: the shared inventory selection is scoped to one workspace owner.
import { beforeEach, describe, expect, it } from "vitest";
import { useInventorySelection } from "@/stores/inventory-selection";

const store = () => useInventorySelection.getState();

beforeEach(() => store().clear());

describe("inventory selection is scoped to a workspace", () => {
  it("keeps the selection while the owner stays the same", () => {
    store().bindOwner("owner-a");
    store().setSelected(new Set(["i1", "i2"]));
    store().bindOwner("owner-a");
    expect(store().selected.size).toBe(2);
  });

  it("drops the selection when the owner on screen changes", () => {
    store().bindOwner("owner-a");
    store().setSelected(new Set(["i1", "i2"]));
    store().bindOwner("owner-b");
    expect(store().selected.size).toBe(0);
    expect(store().ownerId).toBe("owner-b");
  });

  it("clear() empties it and forgets the owner, as sign-out and a switch do", () => {
    store().bindOwner("owner-a");
    store().setSelected((prev) => new Set([...prev, "i1"]));
    store().clear();
    expect(store().selected.size).toBe(0);
    expect(store().ownerId).toBeNull();
  });
});
