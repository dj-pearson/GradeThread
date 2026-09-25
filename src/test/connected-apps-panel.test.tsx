// DEV-04: the connected-apps list is a security control. A failed read must
// never look like "nothing connected", Disconnect needs a confirm, and two
// quick disconnects keep both buttons disabled until each settles.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: mocks.fetch }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/toast-error", () => ({ toastError: vi.fn() }));

import { ConnectedAppsPanel } from "@/components/api/connected-apps-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONNECTIONS = [
  { id: "g1", client_id: "https://claude.ai/one", client_name: "Claude", scopes: ["read"], connected_at: "2026-09-01T00:00:00Z" },
  { id: "g2", client_id: "https://tool.example/two", client_name: null, scopes: ["submit"], connected_at: "2026-09-02T00:00:00Z" },
];

let listResponse: () => Promise<Response>;
const revokes: Array<{ id: string; release: () => void }> = [];

beforeEach(() => {
  revokes.length = 0;
  listResponse = async () => new Response(JSON.stringify({ connections: CONNECTIONS }), { status: 200 });
  mocks.fetch.mockReset().mockImplementation((path: string, opts: { method?: string } = {}) => {
    if (path === "/api/oauth/connections") return listResponse();
    const m = /^\/api\/oauth\/connections\/([^/]+)\/revoke$/.exec(path);
    if (m && opts.method === "POST") {
      return new Promise<Response>((resolve) => {
        revokes.push({ id: m[1]!, release: () => resolve(new Response("{}", { status: 200 })) });
      });
    }
    return Promise.resolve(new Response("{}", { status: 500 }));
  });
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = "";
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
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => root!.render(<QueryClientProvider client={qc}><ConnectedAppsPanel /></QueryClientProvider>));
  await flush();
}

function disconnectButtons(): HTMLButtonElement[] {
  return Array.from(container!.querySelectorAll("button")).filter((b) =>
    b.textContent?.includes("Disconnect"),
  ) as HTMLButtonElement[];
}

async function click(el: HTMLElement) {
  await act(async () => el.click());
  await flush();
}

async function confirm() {
  const action = Array.from(document.querySelectorAll('[role="alertdialog"] button')).find(
    (b) => b.textContent === "Disconnect",
  ) as HTMLButtonElement;
  await click(action);
}

describe("ConnectedAppsPanel (DEV-04)", () => {
  it("a failed read shows an error card with Retry, not nothing", async () => {
    listResponse = async () => new Response("{}", { status: 500 });
    await render();
    expect(container!.textContent).toContain("We could not load your connected apps");
    listResponse = async () => new Response(JSON.stringify({ connections: CONNECTIONS }), { status: 200 });
    const retry = Array.from(container!.querySelectorAll("button")).find((b) => b.textContent?.includes("Try again"))!;
    await click(retry);
    expect(container!.textContent).toContain("claude.ai");
  });

  it("an empty, successful read renders nothing", async () => {
    listResponse = async () => new Response(JSON.stringify({ connections: [] }), { status: 200 });
    await render();
    expect(container!.textContent).toBe("");
  });

  it("Disconnect asks first and fires nothing until confirmed", async () => {
    await render();
    await click(disconnectButtons()[0]!);
    expect(revokes).toHaveLength(0);
    expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Disconnect claude.ai?");
    await confirm();
    expect(revokes.map((r) => r.id)).toEqual(["g1"]);
  });

  it("two quick disconnects keep both buttons disabled until each settles", async () => {
    await render();
    await click(disconnectButtons()[0]!);
    await confirm();
    await click(disconnectButtons()[1]!);
    await confirm();
    expect(revokes.map((r) => r.id)).toEqual(["g1", "g2"]);
    expect(disconnectButtons().map((b) => b.disabled)).toEqual([true, true]);
    await act(async () => revokes[1]!.release());
    await flush();
    expect(disconnectButtons()[0]!.disabled).toBe(true);
    await act(async () => revokes[0]!.release());
    await flush();
  });
});
