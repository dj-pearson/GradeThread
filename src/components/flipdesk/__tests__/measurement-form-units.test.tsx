// Lengths are stored in inches. The in/cm toggle used to change only the
// suffix, so 56 typed in cm was saved (and listed) as 56 in.
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/flipdesk/size-guide-panel", () => ({ SizeGuidePanel: () => null }));

const { MeasurementForm } = await import("@/components/flipdesk/measurement-form");
const { useMeasurementPrefs } = await import("@/stores/measurement-prefs");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const emitted: Array<Record<string, number | string>> = [];

function Harness() {
  const [values, setValues] = useState<Record<string, number | string>>({});
  return (
    <MeasurementForm
      category="tops"
      brand={null}
      values={values}
      onChange={(next) => {
        emitted.push(next);
        setValues(next);
      }}
    />
  );
}

beforeEach(() => {
  emitted.length = 0;
  useMeasurementPrefs.setState({ unit: "cm" });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <Harness />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const firstInput = () => host.querySelector<HTMLInputElement>('input[type="number"]')!;
const unitButton = (u: string) =>
  Array.from(host.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Length unit"] button')).find(
    (b) => b.textContent === u,
  )!;

describe("MeasurementForm in cm", () => {
  it("stores inches, and shows the same length in either unit", () => {
    const input = firstInput();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "56");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const stored = Object.values(emitted.at(-1)!)[0];
    expect(stored).toBeCloseTo(22.05, 2);
    // Still reads what was typed while the field has focus.
    expect(firstInput().value).toBe("56");

    act(() => input.dispatchEvent(new FocusEvent("blur", { bubbles: false })));
    act(() => unitButton("in").click());
    expect(unitButton("in").getAttribute("aria-pressed")).toBe("true");
    expect(firstInput().value).toBe("22.05");

    act(() => unitButton("cm").click());
    expect(firstInput().value).toBe("56");
  });
});
