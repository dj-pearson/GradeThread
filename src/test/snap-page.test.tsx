import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SnapResult } from "@/hooks/use-snap";

const state = vi.hoisted(() => ({ data: null as SnapResult | null }));
vi.mock("@/hooks/use-snap", async (original) => ({
  ...(await original<typeof import("@/hooks/use-snap")>()),
  useSnap: () => ({
    data: state.data,
    isSuccess: state.data != null,
    isPending: false,
    isError: false,
    error: null,
    mutate: vi.fn(),
    reset: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
const nav = vi.hoisted(() => ({ calls: [] as Array<[string, unknown]> }));
vi.mock("react-router", async (original) => ({
  ...(await original<typeof import("react-router")>()),
  useNavigate: () => (to: string, opts?: unknown) => {
    nav.calls.push([to, opts]);
  },
}));
vi.mock("@/components/help/page-help", () => ({ PageHelp: () => null }));
vi.mock("@/components/flipdesk/pwa-install-banner", () => ({ PwaInstallBanner: () => null }));

import { SnapToValuePage } from "@/pages/snap";
import { mount, settle } from "./helpers/mount";

function result(confidence: number): SnapResult {
  return {
    grade: {
      overall_score: 7.4,
      grade_tier: "very_good",
      confidence,
      factor_scores: { fabric_condition: 8, structural_integrity: 6.5, cosmetic_appearance: 7, functional_elements: 9, odor_cleanliness: 7.5 },
      needs_review: confidence < 0.75,
    },
    value: { lowCents: 1800, medianCents: 3200, highCents: 6400, sampleSize: 12, confidence: 0.5, sufficient: true, currency: "USD", category_name: "Coats & Jackets" },
    usage: { used: 13, cap: 15, resets_at: "2026-10-01T00:00:00.000Z" },
    garment: { type: "jacket", category: "outerwear" },
    estimate: true,
    disclaimer: "estimate",
  };
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
});
afterEach(() => {
  state.data = null;
});

// The page only renders a live result once it knows what was submitted, which
// happens in valueIt. A revisited history entry is the other source, and it
// exercises the same card.
function plantHistory(r: SnapResult) {
  localStorage.setItem(
    "gt.snap-history.v2:u1",
    JSON.stringify([{ id: "e1", at: new Date().toISOString(), brand: "Patagonia", keyword: null, grade: 7.4, gradeTier: "very_good", valueCents: 3200, result: r }]),
  );
}

async function openFirstHistoryRow(container: HTMLElement) {
  const row = container.querySelector<HTMLButtonElement>("li button[aria-pressed]");
  expect(row).toBeTruthy();
  await act(async () => row!.click());
  await settle();
}

describe("the snap result card (SNAP-11, SNAP-12)", () => {
  it("leads with the median, names the comps and warns on low confidence", async () => {
    plantHistory(result(0.6));
    const m = mount(<SnapToValuePage />);
    await settle();
    await openFirstHistoryRow(m.container);
    const text = m.container.textContent ?? "";
    expect(text).toContain("~7.4");
    expect(text).toContain("One photo is not enough to be sure");
    expect(text).toContain("$32");
    expect(text).toContain("$18 to $64");
    expect(text).toContain("from 12 sold comps in Coats & Jackets");
    // Weakest factor first.
    const factors = Array.from(m.container.querySelectorAll('ul[aria-label^="Condition factors"] li')).map((li) => li.textContent);
    expect(factors[0]).toContain("Structural Integrity");
    // The result heading takes focus.
    expect(document.activeElement?.tagName).toBe("H2");
    // Announced for screen readers.
    expect(m.container.querySelector('[role="status"]')?.textContent).toContain("Value about $32");
    m.unmount();
  });

  it("a confident grade has no tilde and no warning", async () => {
    plantHistory(result(0.9));
    const m = mount(<SnapToValuePage />);
    await settle();
    await openFirstHistoryRow(m.container);
    const text = m.container.textContent ?? "";
    expect(text).not.toContain("~7.4");
    expect(text).not.toContain("One photo is not enough");
    m.unmount();
  });

  it("shows today's history rows with a time of day", async () => {
    plantHistory(result(0.9));
    const m = mount(<SnapToValuePage />);
    await settle();
    const row = m.container.querySelector("li")?.textContent ?? "";
    expect(row).toMatch(/\d{1,2}:\d{2}/);
    m.unmount();
  });
});

describe("buy or pass at the tag price (SNAP-14)", () => {
  function priced(confidence: number): SnapResult {
    const r = result(confidence);
    return { ...r, value: { ...r.value!, lowCents: 2500, medianCents: 4000, highCents: 5500 } };
  }

  async function typeTag(container: HTMLElement, v: string) {
    const input = container.querySelector<HTMLInputElement>("#snap-tag-price")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, v);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("$8 on a $40 median shows a profit figure and Buy", async () => {
    plantHistory(priced(0.9));
    const m = mount(<SnapToValuePage />);
    await settle();
    await openFirstHistoryRow(m.container);
    expect(m.container.textContent).toContain("Pay under $13.33 for a 3x margin.");
    await typeTag(m.container, "8");
    const text = m.container.textContent ?? "";
    expect(text).toContain("About $26.16 profit after eBay fees at the median.");
    expect(text).toContain("Buy");
    m.unmount();
  });

  it("a low-confidence grade gets no verdict", async () => {
    plantHistory(priced(0.6));
    const m = mount(<SnapToValuePage />);
    await settle();
    await openFirstHistoryRow(m.container);
    await typeTag(m.container, "8");
    const text = m.container.textContent ?? "";
    expect(text).not.toContain("profit after eBay fees");
    expect(text).toContain("No buy call on a grade this unsure.");
    m.unmount();
  });
});

describe("Bought it on a history row (SNAP-13 with SNAP-14)", () => {
  function entry(id: string, brand: string) {
    return { id, at: new Date().toISOString(), brand, keyword: null, grade: 7.4, gradeTier: "very_good", valueCents: 3200, result: result(0.9) };
  }

  it("carries the tag price only for the row that is on screen", async () => {
    nav.calls.length = 0;
    localStorage.setItem("gt.snap-history.v2:u1", JSON.stringify([entry("e1", "Patagonia"), entry("e2", "Arcteryx")]));
    const m = mount(<SnapToValuePage />);
    await settle();
    await openFirstHistoryRow(m.container);
    const input = m.container.querySelector<HTMLInputElement>("#snap-tag-price")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "8");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const bought = (name: string) =>
      m.container.querySelector<HTMLButtonElement>(`button[aria-label="Bought it: add ${name} to inventory"]`)!;
    // The other row: the $8 was typed for Patagonia, not for this one.
    await act(async () => bought("Arcteryx").click());
    // The open row: the $8 is its cost.
    await act(async () => bought("Patagonia").click());
    const paid = nav.calls.map(([, o]) => (o as { state: { snap: { paidCents?: number } } }).state.snap.paidCents);
    expect(paid).toEqual([undefined, 800]);
    m.unmount();
  });
});

describe("snap page source (SNAP-10, SNAP-12)", () => {
  const src = readFileSync(resolve(process.cwd(), "src/pages/snap.tsx"), "utf8");

  it("has no em or en dashes", () => {
    expect(src).not.toMatch(/[–—]/);
  });

  it("clears the picker, guards stale picks and locks while busy", () => {
    expect(src).toContain('e.target.value = "";');
    expect(src).toContain("seq !== pickSeq.current");
    expect(src).toContain("disabled={busy}");
    expect(src).toContain('capture="environment"');
    expect(src).toContain('addEventListener("paste"');
    expect(src).toContain("onDrop={onDrop}");
    expect(src).toContain("Grading your photo...");
  });

  it("spells Unlabeled the US way and never uses yellow-600", () => {
    expect(src).toContain("Unlabeled");
    expect(src).not.toContain("Unlabelled");
    expect(src).not.toContain("text-yellow-600");
  });

  it("shows the install banner only after a successful snap, below the result", () => {
    expect(src).toContain('{snap.isSuccess && <PwaInstallBanner variant="snap" />}');
    expect(src.indexOf("<PwaInstallBanner")).toBeGreaterThan(src.indexOf("Your estimate"));
  });

  it("turns a yes into a FlipDesk intake with the snap carried over (SNAP-13)", () => {
    expect(src).toMatch(/navigate\("\/dashboard\/flipdesk\/intake", \{\s*state: \{\s*snap: buildIntakeBridge\(/);
    expect(src).toContain("Add to inventory");
    expect(src).toContain("Bought it");
    expect(src).not.toContain('<Link to="/dashboard/flipdesk">');
  });
});
