// A13: the Team tab's margin box keeps what the seller types, negative money
// reads "-$12.00", the count heatmap has no dollar legend, and errors are
// plain copy.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { mount, settle, type Mounted } from "@/test/helpers/mount";
import { clampMargin, teamErrorMessage } from "@/lib/team-reporting";

const margins: number[] = [];

vi.mock("@/hooks/use-workspace", () => ({
  useWorkspace: () => ({ workspaceOwnerId: "11111111-1111-4111-8111-111111111111" }),
}));
vi.mock("@/lib/team-reporting", async (orig) => {
  const real = await orig<typeof import("@/lib/team-reporting")>();
  return {
    ...real,
    fetchMissReport: vi.fn(async (_o: string, _p: string | null, margin: number) => {
      margins.push(margin);
      return { ...real.EMPTY_MISS_REPORT, targetMargin: margin };
    }),
  };
});

const { OverpayCard } = await import("@/pages/flipdesk/team-report");

let m: Mounted | null = null;
beforeEach(() => {
  margins.length = 0;
});
afterEach(() => {
  m?.unmount();
  m = null;
});

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("target margin input (A13)", () => {
  it("clearing and typing 45 keeps 45 after blur, with one fetch", async () => {
    m = mount(h(OverpayCard, { periodStart: null }), "/dashboard/flipdesk/analytics/team");
    await settle();
    expect(margins).toHaveLength(1);
    const input = m.container.querySelector<HTMLInputElement>("#target-margin")!;
    await act(async () => type(input, ""));
    expect(input.value).toBe("");
    await act(async () => type(input, "4"));
    await act(async () => type(input, "45"));
    await settle();
    expect(margins).toHaveLength(1);
    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await settle();
    expect(input.value).toBe("45");
    expect(margins).toEqual([0.3, 0.45]);
  });

  it("clamps to 1-99", () => {
    expect(clampMargin(0)).toBe(1);
    expect(clampMargin(150)).toBe(99);
    expect(clampMargin(44.6)).toBe(45);
  });
});

describe("Team copy (A13)", () => {
  const src = readFileSync(resolve(process.cwd(), "src/pages/flipdesk/team-report.tsx"), "utf8");

  it("formats money with Intl, so a loss is -$12.00", () => {
    expect(src).toContain('new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })');
    expect(new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(-12)).toBe(
      "-$12.00",
    );
  });

  it("hides the dollar loss swatch on the count heatmap", () => {
    const i = src.indexOf("Scale:");
    expect(src.slice(i, i + 400)).toMatch(/metric !== "count" &&[\s\S]*usd\(-scale\)\} loss/);
  });

  it("never prints the raw error message", () => {
    expect(src).not.toContain("error instanceof Error ? error.message");
    expect(teamErrorMessage({ code: "57014" })).toMatch(/taking too long/);
    expect(teamErrorMessage({ code: "42501" })).toBe("Sign in again.");
    expect(teamErrorMessage(new Error('column "x" does not exist'))).not.toMatch(/column/);
  });
});
