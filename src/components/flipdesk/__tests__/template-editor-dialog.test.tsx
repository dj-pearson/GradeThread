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
});
