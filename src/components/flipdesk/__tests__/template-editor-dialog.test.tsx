// The listing template editor, rendered in jsdom with the API mocked: unsaved
// work is guarded, and the fields form a real <form>.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ListingTemplate } from "@/lib/flipdesk-templates";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Radix's Switch and Select measure themselves; jsdom has no ResizeObserver.
vi.stubGlobal("ResizeObserver", class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

const api = vi.hoisted(() => ({
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
}));
vi.mock("@/lib/flipdesk-templates", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/flipdesk-templates");
  return { ...actual, ...api };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/toast-error", () => ({ toastError: vi.fn() }));
const confirmMock = vi.hoisted(() =>
  vi.fn<(opts: { title: string }) => Promise<boolean>>(() => Promise.resolve(false)),
);
vi.mock("@/components/ui/confirm-dialog", () => ({ useConfirm: () => confirmMock }));

// eBay hooks: disconnected by default; a test flips these to connect.
const ebay = vi.hoisted(() => ({
  connection: null as unknown,
  policies: undefined as unknown,
  conditions: null as unknown,
  aspects: null as unknown,
}));
vi.mock("@/hooks/use-ebay", () => ({
  useEbayConnection: () => ({ data: ebay.connection }),
  useEbayPolicies: (enabled: boolean) => ({
    data: enabled ? ebay.policies : undefined,
    isError: false,
  }),
  useEbayCategoryConditions: (id: string | null, enabled: boolean) => ({
    data: enabled && id ? ebay.conditions : null,
  }),
  useEbayCategoryAspects: (id: string | null) => ({ data: id ? ebay.aspects : null }),
  useEbayCategorySuggest: () => ({ data: undefined, isFetching: false, isError: false }),
}));

const { TemplateEditorDialog } = await import("@/components/flipdesk/template-editor-dialog");

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
const onOpenChange = vi.fn();

export async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function render(
  props: Partial<Parameters<typeof TemplateEditorDialog>[0]> = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container!);
    root.render(
      h(
        QueryClientProvider,
        { client },
        h(TemplateEditorDialog, {
          open: true,
          template: null,
          templates: [],
          nextSortOrder: 3,
          onOpenChange,
          ...props,
        }),
      ),
    );
  });
  await flush();
}

function field(id: string): HTMLInputElement | HTMLTextAreaElement {
  const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el) throw new Error(`no #${id}`);
  return el;
}

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(el: Element, k: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }));
  });
  await flush();
}

beforeEach(() => {
  ebay.connection = null;
  ebay.policies = undefined;
  ebay.conditions = null;
  ebay.aspects = null;
  api.createTemplate.mockReset();
  api.updateTemplate.mockReset();
  api.createTemplate.mockResolvedValue(tpl({ id: "new", name: "Shoes" }));
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(false);
  onOpenChange.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
});

describe("TemplateEditorDialog", () => {
  it("asks before Escape throws away typing, and keeps it on cancel", async () => {
    await render();
    await type(field("tpl-name"), "Shoes");
    await key(field("tpl-name"), "Escape");
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0]![0]).toMatchObject({
      title: "Discard your changes?",
      confirmLabel: "Discard",
      destructive: true,
    });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(field("tpl-name").value).toBe("Shoes");
  });

  it("closes on Escape once the discard is confirmed", async () => {
    confirmMock.mockResolvedValue(true);
    await render();
    await type(field("tpl-name"), "Shoes");
    await key(field("tpl-name"), "Escape");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes without asking when nothing changed", async () => {
    await render({ template: tpl() });
    await key(field("tpl-name"), "Escape");
    expect(confirmMock).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("the fields are a form: submitting it saves, with the next sort order", async () => {
    await render();
    await type(field("tpl-name"), "Shoes");
    const form = field("tpl-name").closest("form")!;
    expect(form).not.toBeNull();
    // Enter in a text input submits through the form's one submit button;
    // every other button is type=button so it cannot be that button.
    const submits = form.querySelectorAll('button[type="submit"]');
    expect(submits).toHaveLength(1);
    expect(submits[0]!.textContent).toContain("Save template");
    await act(async () => {
      form.requestSubmit();
    });
    await flush();
    expect(api.createTemplate).toHaveBeenCalledTimes(1);
    expect(api.createTemplate.mock.calls[0]![0]).toMatchObject({ name: "Shoes", sort_order: 3 });
  });

  it("Ctrl+Enter in a textarea saves", async () => {
    await render();
    await type(field("tpl-name"), "Shoes");
    await key(field("tpl-desc"), "Enter", { ctrlKey: true });
    expect(api.createTemplate).toHaveBeenCalledTimes(1);
  });

  it("does not open on a red error, and shows it after a blur", async () => {
    await render();
    expect(document.getElementById("tpl-name-error")).toBeNull();
    expect(document.body.textContent).not.toContain("Give the template a name");
    await act(async () => {
      field("tpl-name").dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    const err = document.getElementById("tpl-name-error");
    expect(err?.textContent).toContain("Give the template a name");
    expect(field("tpl-name").getAttribute("aria-invalid")).toBe("true");
    expect(field("tpl-name").getAttribute("aria-describedby")).toBe("tpl-name-error");
  });

  it("catches a case-insensitive duplicate on Save and focuses the field instead of saving", async () => {
    await render({ templates: [tpl({ id: "other", name: "Denim" })] });
    await type(field("tpl-name"), "denim");
    const form = field("tpl-name").closest("form")!;
    (document.activeElement as HTMLElement | null)?.blur();
    await act(async () => {
      form.requestSubmit();
    });
    await flush();
    expect(api.createTemplate).not.toHaveBeenCalled();
    expect(document.getElementById("tpl-name-error")?.textContent).toContain(
      'You already have a template called "Denim"',
    );
    expect(document.activeElement).toBe(field("tpl-name"));
  });

  it("editing a row may keep its own name", async () => {
    api.updateTemplate.mockResolvedValue(tpl());
    await render({ template: tpl(), templates: [tpl()] });
    await type(field("tpl-desc"), "Ships fast.");
    await act(async () => {
      field("tpl-name").closest("form")!.requestSubmit();
    });
    await flush();
    expect(api.updateTemplate).toHaveBeenCalledTimes(1);
  });

  describe("eBay pickers", () => {
    const POLICIES = {
      policies: [
        { policy_id: "111", policy_type: "fulfillment", policy_name: "USPS Ground", is_default: true },
        { policy_id: "222", policy_type: "payment", policy_name: "Managed payments", is_default: true },
        { policy_id: "333", policy_type: "return", policy_name: "30 day returns", is_default: false },
      ],
      defaults: {},
    };

    function trigger(id: string): string {
      return document.getElementById(id)?.textContent ?? "";
    }

    it("without eBay, offers typed policy ids and says to connect", async () => {
      await render();
      expect(document.body.textContent).toContain("Connect eBay to pick policies");
      expect(document.querySelector('[aria-label="Shipping policy ID"]')).not.toBeNull();
      expect(document.getElementById("tpl-cat")).not.toBeNull();
    });

    it("with eBay, shows policy names and saves their ids", async () => {
      ebay.connection = { id: "c1" };
      ebay.policies = POLICIES;
      api.updateTemplate.mockResolvedValue(tpl());
      await render({
        template: tpl({ shipping_policy_id: "111", return_policy_id: "333" }),
      });
      expect(document.querySelector('[aria-label="Shipping policy ID"]')).toBeNull();
      expect(trigger("tpl-policy-shipping")).toContain("USPS Ground (eBay default)");
      expect(trigger("tpl-policy-return")).toContain("30 day returns");
      expect(trigger("tpl-policy-payment")).toContain("Account default");
      await act(async () => {
        field("tpl-name").closest("form")!.requestSubmit();
      });
      await flush();
      expect(api.updateTemplate.mock.calls[0]![1]).toMatchObject({
        shipping_policy_id: "111",
        return_policy_id: "333",
        payment_policy_id: "",
      });
    });

    it("keeps an unknown stored policy id and flags it", async () => {
      ebay.connection = { id: "c1" };
      ebay.policies = POLICIES;
      await render({ template: tpl({ shipping_policy_id: "999" }) });
      expect(trigger("tpl-policy-shipping")).toContain("Policy not found on eBay (id 999)");
      expect(document.body.textContent).toContain("not on your eBay account any more");
    });

    it("shows the chosen category by name with Change and clear", async () => {
      ebay.connection = { id: "c1" };
      ebay.aspects = { categoryName: "Clothing > Men > Jeans" };
      await render({ template: tpl({ ebay_category_id: "11483" }) });
      expect(document.body.textContent).toContain("Clothing > Men > Jeans");
      expect(document.querySelector('[aria-label="Clear category"]')).not.toBeNull();
    });

    it("limits conditions to the category and warns about a saved one eBay refuses", async () => {
      ebay.connection = { id: "c1" };
      ebay.aspects = { categoryName: "Dresses" };
      ebay.conditions = {
        categoryId: "63861",
        restricted: true,
        conditionIds: ["1000", "2990"],
        options: [
          { value: "NEW", id: "1000", label: "New with tags" },
          { value: "PRE_OWNED_EXCELLENT", id: "2990", label: "Pre-owned - Excellent" },
        ],
        allowedLabels: [],
      };
      await render({ template: tpl({ ebay_category_id: "63861", ebay_condition: "USED_GOOD" }) });
      expect(document.body.textContent).toContain("eBay does not accept this condition in Dresses");
      const native = document.querySelector("select");
      const values = native ? [...native.querySelectorAll("option")].map((o) => o.value) : [];
      // eBay's two, the "No default" option and the refused saved value only.
      expect(values).toEqual(
        expect.arrayContaining(["NEW", "PRE_OWNED_EXCELLENT", "USED_GOOD"]),
      );
      expect(values).not.toContain("USED_VERY_GOOD");
    });

    it("an allowed saved condition gets no warning", async () => {
      ebay.connection = { id: "c1" };
      ebay.conditions = {
        categoryId: "63861",
        restricted: true,
        conditionIds: ["2990"],
        options: [{ value: "PRE_OWNED_EXCELLENT", id: "2990", label: "Pre-owned - Excellent" }],
        allowedLabels: [],
      };
      await render({
        template: tpl({ ebay_category_id: "63861", ebay_condition: "PRE_OWNED_EXCELLENT" }),
      });
      expect(document.body.textContent).not.toContain("eBay does not accept this condition");
    });
  });
});
