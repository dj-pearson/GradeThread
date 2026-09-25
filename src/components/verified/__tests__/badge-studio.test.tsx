// V4/V5: the Badge Studio names each item, says when its list failed, and
// refuses to make snippets for a pasted certificate that is not the caller's.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BadgeCertificate, OwnedCertLookup } from "@/hooks/use-badge-studio";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const certsState: {
  data: BadgeCertificate[] | undefined;
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  refetch: ReturnType<typeof vi.fn>;
} = { data: [], isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };

const ownedState: {
  data: OwnedCertLookup | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: ReturnType<typeof vi.fn>;
} = { data: undefined, isLoading: false, isError: false, refetch: vi.fn() };

vi.mock("@/hooks/use-badge-studio", () => ({
  useMyCertificates: () => certsState,
  useOwnedCertificate: () => ownedState,
}));

// Radix Select only renders its options while open, which needs pointer
// events jsdom does not have. A native select keeps the same contract.
vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: ReactNode }) => (
    <select data-testid="select" value={value} onChange={(e) => onValueChange(e.target.value)}>
      <option value="" />
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

const { BadgeStudio } = await import("@/components/verified/badge-studio");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const FOREIGN = "99999999-9999-4999-8999-999999999999";

function cert(id: string, title: string): BadgeCertificate {
  return {
    certificateId: id,
    overallScore: 8.5,
    gradeTier: "Excellent",
    finalizedAt: null,
    title,
    brand: "Levi's",
    passportSlug: null,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(<BadgeStudio handle={null} />);
  });
  return container!;
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function choose(value: string) {
  const sel = container!.querySelector<HTMLSelectElement>("[data-testid=select]")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  act(() => {
    setter.call(sel, value);
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  certsState.data = [cert(A, "Blue jeans"), cert(B, "Red jacket")];
  certsState.isLoading = false;
  certsState.isError = false;
  certsState.refetch = vi.fn();
  ownedState.data = undefined;
  ownedState.isLoading = false;
  ownedState.isError = false;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("BadgeStudio", () => {
  it("names each option by its item and brand", () => {
    const c = render();
    const opts = Array.from(c.querySelectorAll("option")).map((o) => o.textContent);
    expect(opts).toContain("Blue jeans · Levi's · 8.5 Excellent");
  });

  it("shows Retry, not 'No certificates yet', when the list fails", () => {
    certsState.isError = true;
    certsState.data = undefined;
    const c = render();
    expect(c.textContent).toContain("Couldn't load your certificates.");
    expect(c.textContent).not.toContain("No certificates yet");
    const retry = Array.from(c.querySelectorAll("button")).find((b) => b.textContent === "Retry");
    act(() => retry!.click());
    expect(certsState.refetch).toHaveBeenCalled();
  });

  it("refuses snippets for a pasted certificate that is not the caller's", () => {
    ownedState.data = { state: "not_owned" };
    const c = render();
    typeInto(c.querySelector<HTMLInputElement>("#badge-paste")!, `https://gradethread.com/cert/${FOREIGN}`);
    expect(c.textContent).toContain("This certificate isn't one of yours.");
    expect(c.textContent).not.toContain("Copy this snippet");
  });

  it("choosing from the list after a paste shows the chosen item's snippets", () => {
    const c = render();
    typeInto(c.querySelector<HTMLInputElement>("#badge-paste")!, A);
    expect(c.textContent).toContain("Snippets for Blue jeans");
    choose(B);
    expect(c.querySelector<HTMLInputElement>("#badge-paste")!.value).toBe("");
    expect(c.textContent).toContain("Snippets for Red jacket");
    expect(c.innerHTML).toContain(`/cert/${B}`);
    expect(c.innerHTML).not.toContain(`/cert/${A}`);
  });
});
