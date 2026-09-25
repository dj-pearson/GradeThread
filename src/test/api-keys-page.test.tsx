// DEV-02 / DEV-03 / DEV-04 / DEV-06 / DEV-13: the Developers page.
//
// What these pin: a member sees one role note and nothing fires; the page gates
// on the workspace OWNER's plan as /api/keys/usage reports it, and a failed
// plan check is an error, not an upsell; the shown-once secret cannot be
// dismissed by a stray Escape and is only ever shown under its own key; the
// revoke dialog names the key; the header is "Developers" in every state.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  workspace: { can: (() => true) as (cap: string) => boolean, isOwner: true as boolean },
}));

vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: mocks.fetch }));
vi.mock("@/hooks/use-tenant-key", () => ({ useTenantKey: () => "owner-1" }));
vi.mock("@/hooks/use-workspace", () => ({ useWorkspace: () => mocks.workspace }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/api/webhook-panel", () => ({ WebhookPanel: () => null }));
vi.mock("@/components/api/api-usage-panel", () => ({ ApiUsagePanel: () => null }));
vi.mock("@/components/api/api-overage-card", () => ({ ApiOverageCard: () => null }));
vi.mock("@/components/api/white-label-panel", () => ({ WhiteLabelPanel: () => null }));
vi.mock("@/components/api/connected-apps-panel", () => ({
  ConnectedAppsPanel: () => <p>connected-apps-panel</p>,
}));
vi.mock("@/components/help/help-link", () => ({ HelpLink: () => null }));

import { ApiKeysPage } from "@/pages/api-keys";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// Radix's Checkbox measures itself; jsdom has no ResizeObserver.
if (!("ResizeObserver" in globalThis)) {
  Object.assign(globalThis, {
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  });
}

const KEY_A = {
  id: "key-a",
  name: "Alpha server",
  key_prefix: "gt_sk_aaaa",
  scopes: ["read"],
  last_used_at: null,
  last_rotated_at: null,
  expires_at: null,
  created_at: "2026-09-01T00:00:00Z",
};
const KEY_B = { ...KEY_A, id: "key-b", name: "Beta worker", key_prefix: "gt_sk_bbbb" };
const KEY_OLD = {
  ...KEY_A,
  id: "key-old",
  name: "Old job",
  key_prefix: "gt_sk_oooo",
  expires_at: "2020-01-01T00:00:00Z",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(status >= 400 ? data : { data }), { status });
}

let usageResponse: () => Promise<Response>;
let rotateResponse: (id: string) => Promise<Response>;
let calls: Array<{ path: string; method: string; json?: unknown }>;

beforeEach(() => {
  calls = [];
  mocks.workspace = { can: () => true, isOwner: true };
  usageResponse = async () => json({ api_access: true, plan: "business" });
  rotateResponse = async (id) => json({ id, key_prefix: `${id}-new`, full_key: `secret-for-${id}` });
  mocks.fetch.mockReset().mockImplementation(async (path: string, opts: { method?: string; json?: unknown } = {}) => {
    const method = opts.method ?? "GET";
    calls.push({ path, method, json: opts.json });
    if (path.startsWith("/api/keys/usage")) return usageResponse();
    if (method === "GET" && path === "/api/keys") return json([KEY_A, KEY_B, KEY_OLD]);
    if (method === "POST" && path === "/api/keys") return json({ full_key: "new-secret" }, 201);
    const rot = /^\/api\/keys\/([^/]+)\/rotate$/.exec(path);
    if (method === "POST" && rot) return rotateResponse(rot[1]!);
    return json({ error: "unexpected" }, 500);
  });
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
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
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root!.render(
    <QueryClientProvider client={qc}><MemoryRouter><ApiKeysPage /></MemoryRouter></QueryClientProvider>,
  ));
  await flush();
}

function text() {
  return document.body.textContent ?? "";
}

function button(label: string | RegExp): HTMLButtonElement {
  const all = Array.from(document.querySelectorAll("button"));
  const found = all.find((b) =>
    typeof label === "string"
      ? b.getAttribute("aria-label") === label || b.textContent?.trim() === label
      : label.test(b.getAttribute("aria-label") ?? "") || label.test(b.textContent ?? ""),
  );
  if (!found) throw new Error(`no button ${label}`);
  return found as HTMLButtonElement;
}

async function click(el: HTMLElement) {
  await act(async () => el.click());
  await flush();
}

async function pressEscape() {
  const target = document.activeElement ?? document.body;
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await flush();
}

function dialog(): HTMLElement | null {
  return document.querySelector('[role="dialog"]');
}

describe("role and plan gate (DEV-03)", () => {
  it("a member sees only the role note, and no /api/keys request fires", async () => {
    mocks.workspace = { can: () => false, isOwner: false };
    await render();
    expect(text()).toContain("Only Admin access or higher can manage API keys and webhooks.");
    expect(document.querySelector("h1")?.textContent).toBe("Developers");
    expect(calls).toEqual([]);
  });

  it("a failed plan check shows an error with retry, never the upsell", async () => {
    usageResponse = async () => json({ error: "boom" }, 500);
    await render();
    expect(text()).toContain("Couldn't check your workspace plan");
    expect(text()).not.toContain("Business plan");
    expect(calls.some((c) => c.path === "/api/keys")).toBe(false);
  });

  it("an admin in a Business workspace sees the key table", async () => {
    mocks.workspace = { can: () => true, isOwner: false };
    await render();
    expect(text()).toContain("Alpha server");
    expect(text()).not.toContain("API access needs the Business plan");
  });

  it("a non-owner in a non-Business workspace is told to ask the owner, with no plans button", async () => {
    mocks.workspace = { can: () => true, isOwner: false };
    usageResponse = async () => json({ api_access: false, plan: "pro" });
    await render();
    expect(text()).toContain("API access needs the Business plan");
    expect(text()).toContain("This workspace is not on Business. Ask the owner to upgrade.");
    expect(text()).not.toContain("View Plans");
  });

  it("DEV-04: connected apps stay visible under the upsell", async () => {
    usageResponse = async () => json({ api_access: false, plan: "pro" });
    await render();
    expect(text()).toContain("View Plans");
    expect(text()).toContain("connected-apps-panel");
  });
});

describe("header (DEV-13)", () => {
  it("the h1 reads Developers while loading and once loaded", async () => {
    let release!: (r: Response) => void;
    usageResponse = () => new Promise((r) => { release = r; });
    await render();
    expect(document.querySelector("h1")?.textContent).toBe("Developers");
    await act(async () => release(json({ api_access: true, plan: "business" })));
    await flush();
    expect(document.querySelector("h1")?.textContent).toBe("Developers");
    expect(text()).toContain("API keys");
  });

  it("the revoke dialog names the key and its prefix", async () => {
    await render();
    await click(button("Revoke the Alpha server API key"));
    expect(dialog()?.textContent).toContain('Revoke "Alpha server" (gt_sk_aaaa...)?');
    expect(dialog()?.textContent).toContain("This can't be undone.");
  });

  it("submitting the create form calls POST /api/keys", async () => {
    await render();
    await click(button("Create Key"));
    const input = document.getElementById("key-name") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Gamma");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.form!.requestSubmit());
    await flush();
    const post = calls.find((c) => c.method === "POST" && c.path === "/api/keys");
    expect(post?.json).toMatchObject({ name: "Gamma" });
  });

  it("no em dash is left in the page or the usage panel", () => {
    for (const rel of ["src/pages/api-keys.tsx", "src/components/api/api-usage-panel.tsx"]) {
      expect(readFileSync(resolve(process.cwd(), rel), "utf8")).not.toContain("—");
    }
  });
});

describe("shown-once secrets (DEV-02)", () => {
  it("Escape during a pending rotate leaves the dialog open", async () => {
    let release!: (r: Response) => void;
    rotateResponse = () => new Promise((r) => { release = r; });
    await render();
    await click(button("Rotate the Alpha server API key"));
    await click(button("Rotate Key"));
    await pressEscape();
    expect(dialog()).not.toBeNull();
    await act(async () => release(json({ id: "key-a", key_prefix: "gt_sk_new", full_key: "secret-for-key-a" })));
    await flush();
    expect(dialog()?.textContent).toContain("secret-for-key-a");
  });

  it("Done stays disabled until the secret is saved, and Escape does not close it", async () => {
    await render();
    await click(button("Rotate the Alpha server API key"));
    await click(button("Rotate Key"));
    expect(dialog()?.textContent).toContain("secret-for-key-a");
    expect(dialog()?.textContent).toContain("Alpha server");
    expect(button("Done").disabled).toBe(true);
    await pressEscape();
    expect(dialog()?.textContent).toContain("secret-for-key-a");
    await click(document.getElementById("rotated-saved") as HTMLElement);
    expect(button("Done").disabled).toBe(false);
    await click(button("Done"));
    expect(dialog()).toBeNull();
  });

  it("a rotate for key A never shows when the dialog is opened for key B", async () => {
    await render();
    await click(button("Rotate the Alpha server API key"));
    await click(button("Rotate Key"));
    await click(document.getElementById("rotated-saved") as HTMLElement);
    await click(button("Done"));
    await click(button("Rotate the Beta worker API key"));
    expect(dialog()?.textContent).toContain('Issue a new secret for "Beta worker"');
    expect(dialog()?.textContent).not.toContain("secret-for-key-a");
  });

  it("the created secret cannot be dismissed with Escape before it is saved", async () => {
    await render();
    await click(button("Create Key"));
    const input = document.getElementById("key-name") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "Gamma");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => input.form!.requestSubmit());
    await flush();
    expect(dialog()?.textContent).toContain("new-secret");
    expect(button("Done").disabled).toBe(true);
    await pressEscape();
    expect(dialog()?.textContent).toContain("new-secret");
  });
});

describe("expired keys (DEV-06)", () => {
  it("an expired row offers Replace, not Rotate", async () => {
    await render();
    expect(() => button("Rotate the Old job API key")).toThrow();
    await click(button("Replace the expired Old job API key"));
    expect((document.getElementById("key-name") as HTMLInputElement).value).toBe("Old job");
  });
});
