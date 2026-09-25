// The listing templates page, rendered for real in jsdom with the API mocked.
// Same harness as grade-submit-once.test.tsx: createRoot + act, no
// @testing-library.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ListingTemplate } from "@/lib/flipdesk-templates";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  listTemplates: vi.fn(),
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
}));
vi.mock("@/lib/flipdesk-templates", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/flipdesk-templates");
  return { ...actual, ...api };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/toast-error", () => ({ toastError: vi.fn() }));
const confirmMock = vi.hoisted(() =>
  vi.fn<(o: { title: string; description?: string }) => Promise<boolean>>(() =>
    Promise.resolve(true),
  ),
);
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => confirmMock }));

const workspace = vi.hoisted(() => ({ canEdit: true }));
vi.mock("@/hooks/use-workspace", () => ({
  useWorkspace: () => ({ can: () => workspace.canEdit }),
}));
vi.mock("@/hooks/use-ebay", () => ({
  useEbayConnection: () => ({ data: null }),
  useEbayPolicies: () => ({ data: undefined, isError: false }),
  useEbayCategoryConditions: () => ({ data: null }),
  useEbayCategoryAspects: () => ({ data: null }),
  useEbayCategorySuggest: () => ({ data: undefined, isFetching: false, isError: false }),
}));
vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

const { TemplatesPage } = await import("@/pages/flipdesk/templates");

export function tpl(over: Partial<ListingTemplate> = {}): ListingTemplate {
  return {
    id: "t1",
    name: "Denim",
    description_template: null,
    ebay_condition: null,
    condition_description: null,
    item_specifics: {},
    ebay_category_id: null,
    return_policy_id: null,
    shipping_policy_id: null,
    payment_policy_id: null,
    is_default: false,
    sort_order: 0,
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let client: QueryClient;

async function render(seed?: ListingTemplate[]) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seed) client.setQueryData(["flipdesk_listing_templates"], seed);
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(
      h(MemoryRouter, null, h(QueryClientProvider, { client }, h(TemplatesPage))),
    );
  });
  await flush();
}

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function button(label: RegExp): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find((b) =>
    label.test(b.textContent ?? "") || label.test(b.getAttribute("aria-label") ?? ""),
  ) as HTMLButtonElement | undefined;
}

beforeEach(() => {
  workspace.canEdit = true;
  for (const f of Object.values(api)) f.mockReset();
  confirmMock.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
});

describe("templates page", () => {
  it("keeps Browse samples disabled until the list has loaded", async () => {
    api.listTemplates.mockReturnValue(new Promise(() => {}));
    await render();
    expect(button(/Browse samples/)?.disabled).toBe(true);
  });

  it("enables Browse samples once the list is loaded", async () => {
    api.listTemplates.mockResolvedValue([tpl()]);
    await render();
    expect(button(/Browse samples/)?.disabled).toBe(false);
  });

  it("keeps a loaded list on screen when a background refetch fails", async () => {
    api.listTemplates.mockRejectedValue(new Error("offline"));
    await render([tpl({ name: "Denim" }), tpl({ id: "t2", name: "Tees" })]);
    await act(async () => {
      await client.refetchQueries({ queryKey: ["flipdesk_listing_templates"] });
    });
    await flush();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Denim");
    expect(text).toContain("Tees");
    expect(text).toContain("Could not refresh.");
    expect(text).not.toContain("Couldn't load your templates");
  });

  it("shows the error state when the list never loaded", async () => {
    api.listTemplates.mockRejectedValue(new Error("offline"));
    await render();
    expect(document.body.textContent).toContain("Couldn't load your templates");
  });

  describe("row actions", () => {
    const rows = () => [
      tpl({ id: "a", name: "Denim", is_default: true, sort_order: 0 }),
      tpl({ id: "b", name: "Tees", sort_order: 1 }),
    ];

    async function click(el: Element | undefined) {
      if (!el) throw new Error("no element");
      await act(async () => {
        (el as HTMLElement).click();
      });
      await flush();
    }

    function badges(): number {
      return [...document.querySelectorAll("span, div")].filter(
        (e) => e.children.length <= 1 && e.textContent?.trim() === "Default",
      ).length;
    }

    it("a viewer sees no write buttons and can only View", async () => {
      workspace.canEdit = false;
      api.listTemplates.mockResolvedValue(rows());
      await render();
      expect(button(/New template/)).toBeUndefined();
      expect(button(/Browse samples/)).toBeUndefined();
      expect(button(/^Delete /)).toBeUndefined();
      expect(button(/the default/)).toBeUndefined();
      expect(button(/^View Denim$/)).toBeDefined();
      expect(button(/^Edit Denim$/)).toBeUndefined();
    });

    it("the star makes a row the only default, without opening the editor", async () => {
      api.listTemplates.mockResolvedValue(rows());
      api.updateTemplate.mockReturnValue(new Promise(() => {}));
      await render();
      await click(button(/^Make Tees the default$/));
      expect(api.updateTemplate).toHaveBeenCalledTimes(1);
      expect(api.updateTemplate.mock.calls[0]![0]).toBe("b");
      expect(api.updateTemplate.mock.calls[0]![1]).toMatchObject({ name: "Tees", is_default: true });
      expect(document.getElementById("tpl-name")).toBeNull();
      expect(button(/^Stop using Tees as the default$/)?.getAttribute("aria-pressed")).toBe("true");
      expect(button(/^Make Denim the default$/)?.getAttribute("aria-pressed")).toBe("false");
      expect(badges()).toBe(1);
    });

    it("a failed star rolls the default back", async () => {
      api.listTemplates.mockResolvedValue(rows());
      api.updateTemplate.mockRejectedValue(new Error("nope"));
      await render();
      api.listTemplates.mockReturnValue(new Promise(() => {}));
      await click(button(/^Make Tees the default$/));
      expect(button(/^Stop using Denim as the default$/)).toBeDefined();
      expect(button(/^Make Tees the default$/)).toBeDefined();
    });

    it("Duplicate opens a new template named '<name> (copy)'", async () => {
      api.listTemplates.mockResolvedValue(rows());
      await render();
      await click(button(/^Duplicate Denim$/));
      const name = document.getElementById("tpl-name") as HTMLInputElement;
      expect(name.value).toBe("Denim (copy)");
      expect(document.body.textContent).toContain("New template");
    });

    it("deleting one row leaves the other rows' Delete enabled", async () => {
      api.listTemplates.mockResolvedValue(rows());
      api.deleteTemplate.mockReturnValue(new Promise(() => {}));
      await render();
      await click(button(/^Delete Denim$/));
      expect(button(/^Delete Denim$/)?.disabled).toBe(true);
      expect(button(/^Delete Denim$/)?.textContent).toContain("Deleting...");
      expect(button(/^Delete Tees$/)?.disabled).toBe(false);
    });

    it("deleting the default names the template that takes over", async () => {
      api.listTemplates.mockResolvedValue(rows());
      confirmMock.mockResolvedValueOnce(false);
      await render();
      await click(button(/^Delete Denim$/));
      expect(confirmMock.mock.calls[0]![0].description).toContain(
          'AutoLister and Publish will start with "Tees" instead',
      );
    });
  });
});
