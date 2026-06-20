import { describe, expect, it } from "vitest";
import {
  ADMIN_SEARCH_GROUP_ORDER,
  countAdminSearch,
  emptyAdminSearchGroups,
  flattenAdminSearch,
  type AdminSearchGroups,
  type AdminSearchResult,
} from "./admin-search";

function result(
  type: AdminSearchResult["type"],
  id: string,
): AdminSearchResult {
  return { type, id, title: id, subtitle: "", href: `/x/${id}`, matched_on: "id" };
}

describe("admin-search helpers", () => {
  it("emptyAdminSearchGroups has all groups empty", () => {
    const g = emptyAdminSearchGroups();
    expect(Object.keys(g).sort()).toEqual(
      ["certificates", "listings", "runbooks", "sales", "submissions", "tickets", "users"],
    );
    expect(countAdminSearch(g)).toBe(0);
    expect(flattenAdminSearch(g)).toEqual([]);
  });

  it("flattens in the declared group order", () => {
    const groups: AdminSearchGroups = {
      users: [result("user", "u1")],
      submissions: [result("submission", "s1")],
      certificates: [],
      listings: [result("listing", "l1"), result("listing", "l2")],
      sales: [],
      tickets: [result("ticket", "t1")],
      runbooks: [result("runbook", "rb1")],
    };
    const flat = flattenAdminSearch(groups);
    expect(flat.map((r) => r.id)).toEqual(["u1", "s1", "l1", "l2", "t1", "rb1"]);
    expect(countAdminSearch(groups)).toBe(6);
  });

  it("tolerates null/undefined input", () => {
    expect(flattenAdminSearch(null)).toEqual([]);
    expect(flattenAdminSearch(undefined)).toEqual([]);
    expect(countAdminSearch(null)).toBe(0);
  });

  it("group order keys match the groups shape", () => {
    const keys = ADMIN_SEARCH_GROUP_ORDER.map((g) => g.key).sort();
    expect(keys).toEqual(
      ["certificates", "listings", "runbooks", "sales", "submissions", "tickets", "users"],
    );
  });
});
