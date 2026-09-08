import { describe, it, expect } from "vitest";
import {
  FILING_FRAMING,
  filingProgress,
  filingSteps,
  formsToFile,
  type FilingSignals,
} from "./filing-walkthrough";

// US-3137 — the filing walkthrough.

/** A seller who has done nothing but sell. The starting state, not an edge case. */
const FRESH: FilingSignals = {
  taxYear: 2026,
  profileSaved: false,
  entityType: "sole_prop",
  accountingMethod: "cash",
  hasEin: false,
  reviewIssueCount: 3,
  expensesWithoutReceipt: 2,
  openingSnapshot: false,
  closingSnapshot: false,
  snapshotItemsWithoutCost: 0,
  platformsWithSales: 2,
  bridgesEntered: 0,
  bridgesWithVariance: 0,
  tripCount: 12,
  vehicleAnswered: false,
  homeOfficeAnswered: false,
  homeOfficeClaimed: false,
  paymentsRecorded: 0,
  duePeriodsElapsed: 3,
  periodClosed: false,
};

/** The same seller, having worked the list to the bottom. */
const READY: FilingSignals = {
  ...FRESH,
  profileSaved: true,
  reviewIssueCount: 0,
  expensesWithoutReceipt: 0,
  openingSnapshot: true,
  closingSnapshot: true,
  bridgesEntered: 2,
  bridgesWithVariance: 0,
  vehicleAnswered: true,
  homeOfficeAnswered: true,
  paymentsRecorded: 3,
  periodClosed: true,
};

describe("the order", () => {
  it("puts the packet last, because it is a print of everything above it", () => {
    const steps = filingSteps(FRESH);
    expect(steps[steps.length - 1]?.key).toBe("packet");
  });

  it("puts the review list before the numbers that read from it", () => {
    // Resolving a review issue moves the P&L, the COGS figure and the packet.
    // Doing it after those means doing them twice.
    const keys = filingSteps(FRESH).map((s) => s.key);
    expect(keys.indexOf("review")).toBeLessThan(keys.indexOf("inventory"));
    expect(keys.indexOf("review")).toBeLessThan(keys.indexOf("packet"));
  });

  it("closes the year before the packet and after the corrections", () => {
    // Closing takes the snapshot, so closing early means reopening.
    const keys = filingSteps(FRESH).map((s) => s.key);
    expect(keys.indexOf("close")).toBeGreaterThan(keys.indexOf("review"));
    expect(keys.indexOf("close")).toBeGreaterThan(keys.indexOf("inventory"));
    expect(keys.indexOf("close")).toBeLessThan(keys.indexOf("packet"));
  });

  it("returns without hanging", () => {
    // The first version had the packet step ask a helper whether every other
    // step was done, and the helper rebuilt the list to find out. It compiled.
    expect(filingSteps(FRESH).length).toBeGreaterThan(0);
    expect(filingSteps(READY).length).toBe(filingSteps(FRESH).length);
  });
});

describe("what each step says when it is not done", () => {
  it("names a consequence, not an instruction", () => {
    for (const step of filingSteps(FRESH)) {
      if (step.ifSkipped == null) continue;
      expect(step.ifSkipped).not.toMatch(/you should|you must|we recommend/i);
    }
  });

  it("drops the consequence once the step is done", () => {
    for (const step of filingSteps(READY)) {
      if (step.status !== "done") continue;
      expect(step.ifSkipped).toBeNull();
    }
  });

  it("names the form line every step feeds", () => {
    for (const step of filingSteps(FRESH)) {
      expect(step.formLines.length).toBeGreaterThan(0);
    }
  });
});

describe("statuses", () => {
  it("marks everything done for a seller who worked the list", () => {
    const steps = filingSteps(READY);
    const outstanding = steps.filter(
      (s) => s.key !== "packet" && s.status !== "done",
    );
    expect(outstanding).toEqual([]);
  });

  it("does not mark the packet done, ever", () => {
    // Downloading a file is not what finishes a tax year, and a green tick
    // there would say it was.
    for (const s of [FRESH, READY]) {
      expect(filingSteps(s).find((x) => x.key === "packet")?.status).not.toBe(
        "done",
      );
    }
  });

  it("calls mileage not-applicable rather than outstanding when no trips exist", () => {
    // A seller who does not drive for the business has not skipped anything.
    const steps = filingSteps({ ...FRESH, tripCount: 0 });
    expect(steps.find((s) => s.key === "mileage")?.status).toBe(
      "not_applicable",
    );
  });

  it("calls the 1099-K step not-applicable with no marketplace sales", () => {
    const steps = filingSteps({ ...FRESH, platformsWithSales: 0 });
    expect(steps.find((s) => s.key === "form1099k")?.status).toBe(
      "not_applicable",
    );
  });

  it("treats an explicit no on the home office as answered", () => {
    // "I do not have one" is a complete answer. Leaving it permanently amber
    // for a seller who works at the kitchen table is how a checklist gets
    // ignored.
    const steps = filingSteps({
      ...FRESH,
      homeOfficeAnswered: true,
      homeOfficeClaimed: false,
    });
    const step = steps.find((s) => s.key === "home_office")!;
    expect(step.status).toBe("done");
    expect(step.detail).toContain("not claiming");
  });

  it("reopens the inventory step when items are valued at zero", () => {
    // Both ends counted, but a count containing items with no cost understates
    // closing inventory and overstates cost of goods sold.
    const steps = filingSteps({ ...READY, snapshotItemsWithoutCost: 4 });
    const step = steps.find((s) => s.key === "inventory")!;
    expect(step.status).toBe("needs_you");
    expect(step.detail).toContain("no purchase price");
  });

  it("reopens the 1099-K step when a platform disagrees with the books", () => {
    const steps = filingSteps({ ...READY, bridgesWithVariance: 1 });
    expect(steps.find((s) => s.key === "form1099k")?.status).toBe("needs_you");
  });

  it("asks for estimated payments only for instalment dates that have passed", () => {
    // In February no date has passed, so a seller with nothing recorded is not
    // behind on anything.
    const early = filingSteps({ ...FRESH, duePeriodsElapsed: 0 });
    expect(early.find((s) => s.key === "estimated")?.status).toBe(
      "not_applicable",
    );
    const later = filingSteps({
      ...FRESH,
      duePeriodsElapsed: 2,
      paymentsRecorded: 2,
    });
    expect(later.find((s) => s.key === "estimated")?.status).toBe("done");
  });
});

describe("progress", () => {
  it("counts neither the packet nor a not-applicable step", () => {
    const steps = filingSteps({ ...READY, tripCount: 0, platformsWithSales: 0 });
    const p = filingProgress(steps);
    expect(p.total).toBe(
      steps.filter((s) => s.key !== "packet" && s.status !== "not_applicable")
        .length,
    );
    expect(p.done).toBe(p.total);
  });

  it("points at the first outstanding step", () => {
    expect(filingProgress(filingSteps(FRESH)).next?.key).toBe("profile");
  });

  it("points at the packet once the list is worked", () => {
    // The packet is never "done", so it is what remains at the bottom. That is
    // the correct next action, not a bug.
    expect(filingProgress(filingSteps(READY)).next?.key).toBe("packet");
  });
});

describe("what actually gets filed", () => {
  it("names Schedule C, Schedule SE and the 1040 for a sole proprietor", () => {
    const forms = formsToFile(READY).map((f) => f.form);
    expect(forms).toContain("Schedule C");
    expect(forms).toContain("Schedule SE");
    expect(forms).toContain("Form 1040");
  });

  it("treats a single-member LLC the same, and says why", () => {
    const forms = formsToFile({ ...READY, entityType: "single_member_llc" });
    expect(forms.map((f) => f.form)).toContain("Schedule C");
    expect(forms[0]?.because).toContain("single-member LLC");
  });

  it("refuses to guess the form for an entity that does not use Schedule C", () => {
    // An S corporation does not file one, and inventing a form number for a
    // seller whose situation this product does not model would be worse than
    // saying so.
    const forms = formsToFile({ ...READY, entityType: "s_corp" });
    expect(forms.map((f) => f.form)).not.toContain("Schedule C");
    expect(forms[0]?.what).toContain("S corporation");
  });

  it("adds Part IV only when there is mileage", () => {
    expect(
      formsToFile({ ...READY, tripCount: 0 }).map((f) => f.form),
    ).not.toContain("Schedule C Part IV");
    expect(formsToFile(READY).map((f) => f.form)).toContain(
      "Schedule C Part IV",
    );
  });

  it("says why every form is on the list", () => {
    for (const f of formsToFile(READY)) {
      expect(f.because.length).toBeGreaterThan(0);
    }
  });
});

describe("the framing", () => {
  it("says all four refusals in one sentence a seller will actually read", () => {
    expect(FILING_FRAMING).toContain("not tax advice");
    expect(FILING_FRAMING).toContain("does not file");
    expect(FILING_FRAMING).toMatch(/SSN|EIN/);
  });
});
