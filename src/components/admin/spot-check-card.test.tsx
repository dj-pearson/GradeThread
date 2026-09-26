// US-3524: the blind spot-check card never shows the AI's grade before the
// reviewer's own score is saved.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const edgeFetch = vi.fn();
vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: (...args: unknown[]) => edgeFetch(...args) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { SpotCheckCard } from "./spot-check-card";

const ITEM = {
  report_id: "r1",
  requested_at: "2026-09-26T10:00:00Z",
  submission: { title: "Trucker jacket", brand: "Levi's", garment_type: "outerwear", garment_category: "jacket" },
  images: [{ id: "i1", image_type: "front", signed_url: "https://example.test/front.jpg" }],
};
const REVEAL = { ok: true, blind_overall: 7.6, blind_tier: "Very Good", ai_overall: 9.1, ai_tier: "NWOT", difference: -1.5 };

function json(body: unknown, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) });
}

let root: Root;
let container: HTMLDivElement;

async function flush() {
  for (let i = 0; i < 10; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  edgeFetch.mockReset();
  edgeFetch.mockImplementation((_url: string, init?: { method?: string }) =>
    init?.method === "POST" ? json(REVEAL) : json({ data: [ITEM] })
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={qc}><SpotCheckCard /></QueryClientProvider>));
  await flush();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("SpotCheckCard", () => {
  it("shows the garment and photos with no AI score", () => {
    expect(container.textContent).toContain("Trucker jacket");
    expect(container.textContent).not.toContain("9.1");
    expect(container.textContent).not.toContain("NWOT");
  });

  it("keeps save disabled until all five scores are valid half steps", async () => {
    const save = [...container.querySelectorAll("button")].find((b) => b.textContent === "Save blind score")!;
    expect(save.disabled).toBe(true);
    const inputs = [...container.querySelectorAll<HTMLInputElement>("input[id^='spot-']")];
    expect(inputs).toHaveLength(5);
    await act(async () => inputs.forEach((i) => setInput(i, "7.3")));
    expect(save.disabled).toBe(true);
    await act(async () => inputs.forEach((i) => setInput(i, "7.5")));
    expect(save.disabled).toBe(false);
  });

  it("reveals the AI grade only after the blind score is saved", async () => {
    const inputs = [...container.querySelectorAll<HTMLInputElement>("input[id^='spot-']")];
    await act(async () => inputs.forEach((i) => setInput(i, "7.5")));
    const save = [...container.querySelectorAll("button")].find((b) => b.textContent === "Save blind score")!;
    await act(async () => save.click());
    await flush();
    const post = edgeFetch.mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === "POST")!;
    expect(post[0]).toBe("/api/admin/grading/spot-checks/r1");
    expect(JSON.parse((post[1] as { body: string }).body).factors.fabric_condition_score).toBe(7.5);
    expect(container.textContent).toContain("9.1");
    expect(container.textContent).toContain("1.5 point gap");
  });
});
