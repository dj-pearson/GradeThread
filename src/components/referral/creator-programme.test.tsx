// The tax form: nobody outside the creator program is shown an SSN field, the
// form refuses to go without the certification and an address, and Enter
// submits it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Radix's checkbox and select measure themselves; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

let status: Record<string, unknown> = {};
const posts: Array<{ url: string; body: unknown }> = [];
vi.mock("@/lib/edge-fetch", () => ({
  edgeFetch: async (url: string, opts?: { method?: string; body?: string }) => {
    if (opts?.method === "POST") {
      posts.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
      return new Response(JSON.stringify({ ok: true, last4: "6789" }), { status: 200 });
    }
    return new Response(JSON.stringify(status), { status: 200 });
  },
}));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

import { CreatorProgramme } from "@/components/referral/creator-programme";
import { taxFormErrors } from "@/lib/referral-page";

const BASE = {
  program: "user",
  code: "ABCD2345",
  commission_pct: 25,
  cap_usd: 250,
  window_months: 12,
  hold_days: 30,
  earnings: { clicks: 0, signups: 0, owed: 0, payable: 0, held: 0, paid: 0, accounts: [] },
  terms_version: "2026-09-01",
  accepted_version: null,
  accepted_at: null,
  terms_current: false,
  approved_at: null,
  tax_profile: { certified: false, certified_at: null, legal_name: null, entity_type: null, last4: null },
};

let root: Root | null = null;
let container: HTMLDivElement;
beforeEach(() => {
  posts.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
});
afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

async function render() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root = createRoot(container);
    root.render(
      <QueryClientProvider client={qc}>
        <CreatorProgramme />
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("CreatorProgramme tax form", () => {
  it("a seller who is not an admitted creator sees no SSN field", async () => {
    status = { ...BASE, program: "user", accepted_at: "2026-09-02T00:00:00Z", accepted_version: "2026-09-01", terms_current: true };
    await render();
    expect(container.querySelector("#creator-tin")).toBeNull();
    expect(container.textContent).toContain("Once we admit you, we'll ask for tax details here.");
  });

  it("an admitted creator gets a masked TIN field in a form", async () => {
    status = { ...BASE, program: "creator", accepted_at: "2026-09-02T00:00:00Z", accepted_version: "2026-09-01", terms_current: true };
    await render();
    const tin = container.querySelector<HTMLInputElement>("#creator-tin")!;
    expect(tin.type).toBe("password");
    expect(tin.getAttribute("autocomplete")).toBe("off");
    expect(tin.hasAttribute("data-sentry-mask")).toBe(true);
    expect(tin.className).toContain("ph-no-capture");
    expect(tin.closest("form")).not.toBeNull();
  });

  it("Enter submits, and without the certify box and an address nothing is sent", async () => {
    status = { ...BASE, program: "creator", accepted_at: "2026-09-02T00:00:00Z", accepted_version: "2026-09-01", terms_current: true };
    await render();
    type(container.querySelector<HTMLInputElement>("#creator-legal-name")!, "Pat Seller");
    type(container.querySelector<HTMLInputElement>("#creator-tin")!, "123456789");
    const form = container.querySelector("form")!;
    await act(async () => {
      form.requestSubmit();
    });
    expect(posts.filter((p) => p.url === "/api/affiliate/tax-profile")).toHaveLength(0);
    expect(container.textContent).toContain("Tick the box to certify.");
    expect(container.textContent).toContain("Enter your street address.");
  });

  it("the accept button stays off until the terms box is ticked", async () => {
    status = { ...BASE };
    await render();
    const accept = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Accept and apply")!;
    expect(accept.disabled).toBe(true);
    const link = container.querySelector<HTMLAnchorElement>('a[href="/partners"]')!;
    expect(link.target).toBe("_blank");
  });
});

describe("taxFormErrors", () => {
  const full = {
    legalName: "Pat Seller",
    tin: "123-45-6789",
    addressLine1: "1 Main St",
    city: "Des Moines",
    region: "IA",
    postalCode: "50309",
    certify: true,
  };
  it("passes a full, certified form", () => {
    expect(taxFormErrors(full)).toEqual({});
  });
  it("refuses a form without the certification or the address", () => {
    expect(Object.keys(taxFormErrors({ ...full, certify: false }))).toEqual(["certify"]);
    expect(Object.keys(taxFormErrors({ ...full, addressLine1: "", region: "" })).sort()).toEqual([
      "address_line1",
      "region",
    ]);
  });
});
