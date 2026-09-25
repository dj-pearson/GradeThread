// MeasureCard page, rendered. The source guards in src/test/measure-card-page
// .test.ts pin the contracts with the server; this drives the page with a
// mocked edge and asserts what a seller actually sees and what gets sent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Call = { path: string; init?: { method?: string; json?: unknown } };
const calls: Call[] = [];
let getBody: unknown = null;

function jsonRes(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  });
}

vi.mock("@/lib/edge-fetch", () => ({
  edgeFetch: (path: string, init?: Call["init"]) => {
    calls.push({ path, init });
    if (path === "/api/flipdesk/measure/card-request" && !init?.method) {
      return jsonRes(getBody);
    }
    if (path === "/api/flipdesk/measure/card-request") {
      return jsonRes(
        {
          ok: true,
          request: {
            id: "r-new",
            status: "requested",
            card_version: 2,
            requested_at: "2026-09-25T00:00:00Z",
            shipped_at: null,
            tracking_number: null,
            tracking_carrier: null,
          },
        },
        201,
      );
    }
    return jsonRes({});
  },
}));
vi.mock("@/hooks/use-workspace", () => ({
  useWorkspace: () => ({ workspaceOwnerId: "owner-1", role: "owner" }),
}));
vi.mock("@/components/help/page-help", () => ({ PageHelp: () => null }));
vi.mock("sonner", () => ({
  toast: { success: () => {}, error: () => {}, warning: () => {}, info: () => {} },
}));

const { FlipdeskMeasureCardPage } = await import("@/pages/flipdesk/measure-card");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(state: unknown) {
  getBody = state;
  container = document.createElement("div");
  document.body.appendChild(container);
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  await act(async () => {
    root = createRoot(container!);
    root.render(
      h(
        QueryClientProvider,
        { client: qc },
        h(MemoryRouter, null, h(FlipdeskMeasureCardPage)),
      ),
    );
  });
  // Let the query resolve.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function text(): string {
  return container?.textContent ?? "";
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(container!.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;
}

function type(id: string, value: string) {
  const el = container!.querySelector<HTMLInputElement>(`#${id}`)!;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const OK = { request: null, eligibility: { can_request: true, reason: "ok" } };

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

describe("the address form (MC-08)", () => {
  it("caps the postal code at the server's limit", async () => {
    await mount(OK);
    const zip = container!.querySelector<HTMLInputElement>("#mc-zip");
    expect(zip?.getAttribute("maxlength")).toBe("20");
    expect(zip?.getAttribute("autocomplete")).toBe("postal-code");
  });

  it("shows the address back for review before anything is POSTed", async () => {
    await mount(OK);
    type("mc-name", "Pat Doe");
    type("mc-a1", "1 Main St");
    type("mc-city", "Austin");
    type("mc-state", "TX");
    type("mc-zip", "78701");
    const form = container!.querySelector("form")!;
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    const review = container!.querySelector('[data-testid="mc-review"]');
    expect(review?.textContent).toContain("1 Main St");
    expect(review?.textContent).toContain("Austin, TX, 78701");
    expect(text()).toContain("We will mail it to:");
    expect(calls.some((c) => c.init?.method === "POST")).toBe(false);

    await act(async () => {
      button("Confirm and request")!.click();
      await new Promise((r) => setTimeout(r, 0));
    });
    const post = calls.find((c) => c.init?.method === "POST");
    expect(post?.path).toBe("/api/flipdesk/measure/card-request");
    expect((post?.init?.json as { ship_name: string }).ship_name).toBe("Pat Doe");
    // MC-07: the status comes from the POST answer, with no second GET.
    const gets = calls.filter(
      (c) => c.path === "/api/flipdesk/measure/card-request" && !c.init?.method,
    );
    expect(gets).toHaveLength(1);
    expect(text()).toContain("Requested");
  });

  it("Edit goes back to the filled-in form", async () => {
    await mount(OK);
    type("mc-name", "Pat Doe");
    act(() => {
      container!.querySelector("form")!.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    act(() => {
      button("Edit")!.click();
    });
    expect(container!.querySelector<HTMLInputElement>("#mc-name")?.value).toBe("Pat Doe");
  });
});

describe("eligibility from the server (MC-01)", () => {
  it("a viewer is told why and sees no form", async () => {
    await mount({ request: null, eligibility: { can_request: false, reason: "viewer" } });
    expect(text()).toContain("Only teammates who can edit can request a card");
    expect(container!.querySelector("#mc-name")).toBeNull();
  });

  it("a free-plan workspace sees the upgrade copy and no form", async () => {
    await mount({ request: null, eligibility: { can_request: false, reason: "free_plan" } });
    expect(text()).toContain("included with paid plans");
    expect(container!.querySelector("#mc-name")).toBeNull();
  });
});
