// DEV-08: a failed branding load must not become a save that wipes it, the
// snippet is built from SAVED branding, and bad input is caught inline.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: mocks.fetch }));
vi.mock("@/hooks/use-tenant-key", () => ({ useTenantKey: () => "owner-1" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { WhiteLabelPanel } from "@/components/api/white-label-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let getResponse: () => Response;
let puts: unknown[];

beforeEach(() => {
  puts = [];
  getResponse = () => new Response(JSON.stringify({ data: { company_name: "Acme", brand_color: "#0F3460" } }), { status: 200 });
  mocks.fetch.mockReset().mockImplementation(async (path: string, opts: { method?: string; json?: unknown } = {}) => {
    if (path === "/api/keys/branding" && (opts.method ?? "GET") === "GET") return getResponse();
    if (path === "/api/keys/branding" && opts.method === "PUT") {
      puts.push(opts.json);
      return new Response(JSON.stringify({ data: opts.json }), { status: 200 });
    }
    return new Response("{}", { status: 500 });
  });
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
});

async function flush() {
  for (let i = 0; i < 6; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root!.render(<QueryClientProvider client={qc}><WhiteLabelPanel /></QueryClientProvider>));
  await flush();
}

async function type(id: string, value: string) {
  const input = container!.querySelector(`#${id}`) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}

function saveButton(): HTMLButtonElement | undefined {
  return Array.from(container!.querySelectorAll("button")).find((b) => b.textContent?.includes("Save branding"));
}

describe("WhiteLabelPanel (DEV-08)", () => {
  it("a failed GET shows Retry and no Save button", async () => {
    getResponse = () => new Response("{}", { status: 500 });
    await render();
    expect(container!.textContent).toContain("Couldn't load your branding");
    expect(container!.textContent).toContain("Try again");
    expect(saveButton()).toBeUndefined();
  });

  it("a 403 asks for the workspace owner", async () => {
    getResponse = () => new Response("{}", { status: 403 });
    await render();
    expect(container!.textContent).toContain("Ask your workspace owner to set branding.");
    expect(saveButton()).toBeUndefined();
  });

  it("the snippet keeps the SAVED color while an unsaved one is typed, and Copy is off", async () => {
    await render();
    await type("brand-color", "#FFD400");
    const snippet = (container!.querySelector("#embed-snippet") as HTMLTextAreaElement).value;
    expect(snippet).toContain("color=%230F3460");
    expect(snippet).not.toContain("FFD400");
    expect(container!.textContent).toContain("You have unsaved changes");
    const copy = container!.querySelector('[aria-label="Copy embed snippet"]') as HTMLButtonElement;
    expect(copy.disabled).toBe(true);
  });

  it("a short hex is normalized on save, and a bad one is flagged inline and not sent", async () => {
    await render();
    await type("brand-color", "fff");
    await act(async () => saveButton()!.click());
    await flush();
    expect(puts[puts.length - 1]).toMatchObject({ brand_color: "#ffffff" });

    await type("brand-color", "not-a-color");
    const input = container!.querySelector("#brand-color") as HTMLInputElement;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const before = puts.length;
    await act(async () => saveButton()!.click());
    await flush();
    expect(puts.length).toBe(before);
  });

  it("an http logo URL is refused inline", async () => {
    await render();
    await type("brand-logo", "http://acme.test/logo.png");
    expect(container!.textContent).toContain("Use a full https:// address.");
  });

  it("DEV-15: shows the header contrast the embed will use for the typed color", async () => {
    await render();
    await type("brand-color", "#FFD400");
    expect(container!.querySelector('[data-testid="brand-contrast"]')?.textContent).toContain("dark text");
  });
});
