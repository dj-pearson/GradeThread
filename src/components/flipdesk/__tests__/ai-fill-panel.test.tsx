// The AI review panel must keep what the seller does in it. Callers build
// currentValues fresh on every render, and the panel used to re-initialise on
// that, wiping edits and toggles whenever the parent re-rendered.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-ai-extract", () => ({ recordAiAcceptance: vi.fn() }));

const { AiFillPanel } = await import("@/components/flipdesk/ai-fill-panel");
import type { AiExtractResponse } from "@/hooks/use-ai-extract";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const result = {
  suggestions: {
    brand: { value: "Nike", confidence: 0.9, source: "text" },
    color: { value: "Blue", confidence: 0.3, source: "text" },
    sku: { value: "X-1", confidence: 0.9, source: "text" },
  },
  conflicts: [],
  condition_summary: null,
  measurements: null,
  model: "m",
  log_id: null,
  actions_remaining: 5,
  ebay: null,
} as unknown as AiExtractResponse;

let host: HTMLDivElement;
let root: Root;
const onApply = vi.fn();

function render(currentValues: Record<string, string>) {
  act(() =>
    root.render(
      <AiFillPanel
        open
        onOpenChange={() => {}}
        result={result}
        currentValues={currentValues}
        applicableFields={["brand", "color"]}
        onApply={onApply}
      />,
    ),
  );
}

const input = (label: string) =>
  document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);

beforeEach(() => {
  onApply.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

describe("AiFillPanel", () => {
  it("keeps a hand edit across a re-render with an equal but new currentValues", () => {
    render({ brand: "", color: "" });
    const brand = input("Brand")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(brand, "Nike ACG");
      brand.dispatchEvent(new Event("input", { bubbles: true }));
    });
    render({ brand: "", color: "" });
    expect(input("Brand")!.value).toBe("Nike ACG");

    const apply = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent === "Apply",
    )!;
    act(() => apply.click());
    expect(onApply).toHaveBeenCalledWith([
      { field: "brand", value: "Nike ACG", source: "text", confidence: 0.9 },
    ]);
  });

  it("shows only the fields the caller can write", () => {
    render({ brand: "", color: "" });
    expect(input("Brand")).not.toBeNull();
    expect(input("Sku")).toBeNull();
  });

  it("leaves a low-confidence guess switched off", () => {
    render({ brand: "", color: "" });
    const sw = document.body.querySelector('[aria-label="Accept Color"]')!;
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(document.body.querySelector('[aria-label="Accept Brand"]')!.getAttribute("aria-checked")).toBe("true");
  });
});
