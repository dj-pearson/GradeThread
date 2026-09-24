import { describe, it, expect } from "vitest";
import {
  clampedPage,
  DEFAULT_LIST_PARAMS,
  readListParams,
  writeListParams,
} from "@/lib/submissions-list-params";

// SUB-12: the Submissions list's filters, sort and page round-trip through the
// URL, so Back from a detail page, refresh and a new tab all restore them.

describe("submissions list params", () => {
  it("round-trips every field", () => {
    const url = writeListParams(new URLSearchParams(), {
      status: "completed",
      garmentType: "outerwear",
      search: "levi",
      dateFrom: "2026-09-01",
      dateTo: "2026-09-30",
      sortField: "overall_score",
      sortDirection: "asc",
      page: 2,
    });
    expect(url.toString()).toBe(
      "status=completed&type=outerwear&q=levi&from=2026-09-01&to=2026-09-30&sort=overall_score&dir=asc&page=3",
    );
    expect(readListParams(url)).toEqual({
      status: "completed",
      garmentType: "outerwear",
      search: "levi",
      dateFrom: "2026-09-01",
      dateTo: "2026-09-30",
      sortField: "overall_score",
      sortDirection: "asc",
      page: 2,
    });
  });

  it("defaults leave the URL clean", () => {
    expect(writeListParams(new URLSearchParams("page=4&status=failed"), DEFAULT_LIST_PARAMS).toString()).toBe("");
  });

  it("junk parameters open a working page", () => {
    expect(
      readListParams(
        new URLSearchParams("status=nope&type=spaceship&from=yesterday&sort=x&dir=up&page=-3"),
      ),
    ).toEqual(DEFAULT_LIST_PARAMS);
  });

  it("keeps parameters it does not own", () => {
    const next = writeListParams(new URLSearchParams("utm_source=mail"), { page: 1 });
    expect(next.get("utm_source")).toBe("mail");
    expect(next.get("page")).toBe("2");
  });

  it("?page=9 past the end clamps to the last page", () => {
    const { page } = readListParams(new URLSearchParams("page=9"));
    expect(page).toBe(8);
    // 45 rows at 20 a page: pages 0, 1, 2.
    expect(clampedPage(page, 45, 20)).toBe(2);
    expect(clampedPage(1, 45, 20)).toBeNull();
    expect(clampedPage(8, 0, 20)).toBeNull();
  });
});
