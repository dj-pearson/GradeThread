import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DetectedIssues } from "@/components/grade/detected-issues";
import type { DefectFound } from "@/types/database";

// SUB-03: one row per structured flaw, worst first, with the severity in words.

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("DetectedIssues", () => {
  it("renders one row per defect in severity order", () => {
    const defects: DefectFound[] = [
      { defect: "pilling", severity: "minor", location: "sleeve" },
      { defect: "hole", severity: "major", location: "back hem" },
      { defect: "fading", severity: "moderate", location: "collar" },
    ];
    act(() => root.render(<DetectedIssues defects={defects} />));
    const rows = [...container.querySelectorAll("li")].map((li) => li.textContent);
    expect(rows).toEqual([
      "Majorhole · back hem",
      "Moderatefading · collar",
      "Minorpilling · sleeve",
    ]);
    // Wraps rather than clipping inside a nowrap badge.
    expect(container.innerHTML).toContain("break-words");
  });

  it("says no flaws were found when the list is empty", () => {
    act(() => root.render(<DetectedIssues defects={[]} />));
    expect(container.textContent).toContain("No flaws found");
    expect(container.querySelector("li")).toBeNull();
  });
});
