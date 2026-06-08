import { describe, it, expect, afterEach } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FieldError, FormErrorSummary } from "@/components/ui/form-feedback";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(node);
  });
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

describe("FieldError", () => {
  it("renders nothing when there is no message", () => {
    render(h(FieldError, { id: "x", children: undefined }));
    expect(container!.textContent).toBe("");
    expect(container!.querySelector("[role=alert]")).toBeNull();
  });

  it("renders the message as an alert", () => {
    render(h(FieldError, { id: "x-error", children: "Title is required" }));
    const el = container!.querySelector("[role=alert]");
    expect(el?.textContent).toBe("Title is required");
    expect(el?.id).toBe("x-error");
  });
});

describe("FormErrorSummary", () => {
  it("renders nothing when every error is empty", () => {
    render(h(FormErrorSummary, { errors: [undefined, null, ""] }));
    expect(container!.querySelector("[role=alert]")).toBeNull();
  });

  it("lists only the non-empty messages", () => {
    render(
      h(FormErrorSummary, {
        errors: ["Type is required", undefined, "Title is required"],
      }),
    );
    const items = container!.querySelectorAll("li");
    expect(items.length).toBe(2);
    expect(container!.textContent).toContain("Type is required");
    expect(container!.textContent).toContain("Title is required");
  });
});
