// US-1875: DOM fixture tests for the Lister delist flow + probe ordering (AC5).
//
// These drive the real content-script helpers (extension-unified/lister/common.js)
// against real jsdom fixtures, because the two bugs they guard are both about what
// the DOM looks like AT A GIVEN MOMENT — which is exactly what a unit test with a
// stubbed DOM would paper over:
//
//   F5 (AC1) — the probe demanded `remove` before the menu was clicked, but that
//   control only exists once the menu is OPEN. The required set was unsatisfiable,
//   so the shipped-enabled Poshmark delist bailed at the probe on every single run
//   and told sellers the site had changed.
//
//   F6 (AC2) — the flow reported delisted:true straight after clicking, with no
//   check that anything happened. This is the nastiest failure in the product: a
//   false "delisted" clears the pending-delist stamp and leaves the item live after
//   it sold elsewhere. Double sale.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

interface DelistFlow {
  enabled: boolean;
  version: string;
  required: string[];
  menu: string;
  remove: string;
  confirm?: string;
  verify?: { urlChanged?: boolean; gone?: string; toast?: string };
  // Real waits are 6s/8s. The fixtures drive the same branches on a short clock so
  // the suite doesn't spend half a minute asleep proving a timeout times out.
  timeouts?: { control?: number; verify?: number };
}

interface Lister {
  probe(flow: unknown, timeoutMs?: number): Promise<string[]>;
  isLoginWall(cfg: unknown): boolean;
  runDelistFlow(flow: DelistFlow, payload: unknown): Promise<Record<string, unknown>>;
  verifyDelist(flow: DelistFlow, ctx: unknown, timeoutMs?: number): Promise<string | null>;
}

let GT: Lister;

const PAYLOAD = { platform: "poshmark", platformLabel: "Poshmark" };

// Mirrors the shipped Poshmark delist config (selectors.js) — kept literal so a bad
// config change fails here rather than in front of a seller.
const FLOW = (): DelistFlow => ({
  enabled: true,
  version: "2026.07.1",
  required: ["menu"],
  menu: "button.listing-menu",
  remove: "button.delete-listing",
  confirm: "button.confirm-delete",
  verify: {
    urlChanged: true,
    gone: "button.listing-menu",
    toast: ".toast--success",
  },
  timeouts: { control: 150, verify: 250 },
});

/** A live listing page: the menu exists, the delete control does NOT (it's inside). */
function liveListing() {
  document.body.innerHTML = `<button class="listing-menu">…</button>`;
}

/**
 * Wire the fixture to behave like the real marketplace: opening the menu reveals
 * the delete control; deleting reveals the confirm button.
 */
function wireMenu(opts: { onConfirm?: () => void } = {}) {
  const menu = document.querySelector("button.listing-menu")!;
  menu.addEventListener("click", () => {
    const del = document.createElement("button");
    del.className = "delete-listing";
    del.addEventListener("click", () => {
      const c = document.createElement("button");
      c.className = "confirm-delete";
      c.addEventListener("click", () => opts.onConfirm?.());
      document.body.appendChild(c);
    });
    document.body.appendChild(del);
  });
}

beforeAll(async () => {
  // The content-script helpers are a vanilla-JS IIFE that assigns self.GTLister.
  // chrome is absent here; GT.log's own try/catch already tolerates that.
  // @ts-expect-error — untyped .js side-effect import
  await import("../../extension-unified/lister/common.js");
  GT = (globalThis as unknown as { GTLister: Lister }).GTLister;
});

beforeEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("US-1875 AC1: probe validates in interaction order", () => {
  it("passes on a live listing where only the menu is present", async () => {
    liveListing();
    // The shipped required set. If someone re-adds "remove" here, this fails —
    // which is the regression that made delist unusable.
    const missing = await GT.probe(
      { required: FLOW().required, fields: { menu: FLOW().menu, remove: FLOW().remove } },
      50,
    );
    expect(missing).toEqual([]);
  });

  it("demonstrates the OLD required set could never be satisfied pre-interaction", async () => {
    liveListing();
    const missing = await GT.probe(
      { required: ["menu", "remove"], fields: { menu: FLOW().menu, remove: FLOW().remove } },
      50,
    );
    // `remove` is inside the unopened menu — this is why the old flow always bailed.
    expect(missing).toEqual(["remove"]);
  });

  it("reports a genuinely broken page", async () => {
    document.body.innerHTML = `<div>nothing here</div>`;
    const missing = await GT.probe(
      { required: FLOW().required, fields: { menu: FLOW().menu, remove: FLOW().remove } },
      50,
    );
    expect(missing).toEqual(["menu"]);
  });
});

describe("US-1875 AC4: independent probe waits run concurrently", () => {
  it("bounds a fully-broken probe at ~one timeout, not one per selector", async () => {
    document.body.innerHTML = `<div></div>`;
    const started = Date.now();
    const missing = await GT.probe(
      {
        required: ["a", "b", "c", "d"],
        fields: { a: ".a", b: ".b", c: ".c", d: ".d" },
      },
      300,
    );
    const elapsed = Date.now() - started;
    expect(missing).toEqual(["a", "b", "c", "d"]);
    // Serial would be ~4×300 = 1200ms. Concurrent is ~300ms. The midpoint is a
    // generous, non-flaky boundary that still fails the serial implementation.
    expect(elapsed).toBeLessThan(700);
  });
});

describe("US-1875 AC2: success requires positive verification", () => {
  it("reports delisted only when the delete is verified (toast)", async () => {
    liveListing();
    wireMenu({
      onConfirm: () => {
        const t = document.createElement("div");
        t.className = "toast--success";
        document.body.appendChild(t);
      },
    });
    const r = await GT.runDelistFlow(FLOW(), PAYLOAD);
    expect(r.ok).toBe(true);
    expect(r.delisted).toBe(true);
    expect(r.verifiedBy).toBe("toast");
  });

  it("verifies via the listing control disappearing", async () => {
    liveListing();
    wireMenu({
      onConfirm: () => {
        document.querySelector("button.listing-menu")?.remove();
      },
    });
    const r = await GT.runDelistFlow(FLOW(), PAYLOAD);
    expect(r.ok).toBe(true);
    expect(r.verifiedBy).toBe("gone");
  });

  it("THE BIG ONE: a click that silently no-ops is NOT reported as delisted", async () => {
    liveListing();
    wireMenu({ onConfirm: () => { /* the request fails; the page does nothing */ } });

    const r = await GT.runDelistFlow(FLOW(), PAYLOAD);

    // The old code returned ok:true/delisted:true here — leaving a sold item live.
    expect(r.ok).toBe(false);
    expect(r.delisted).toBeUndefined();
    expect(r.unverified).toBe(true);
    expect(r.manual).toBe(true);
    expect(String(r.error)).toMatch(/couldn't confirm/i);
  });

  it("does not claim success when the confirm dialog never appears", async () => {
    liveListing();
    const menu = document.querySelector("button.listing-menu")!;
    menu.addEventListener("click", () => {
      const del = document.createElement("button");
      del.className = "delete-listing";
      document.body.appendChild(del); // clicking it renders no confirm
    });
    const r = await GT.runDelistFlow(FLOW(), PAYLOAD);
    expect(r.ok).toBe(false);
    expect(r.unverified).toBe(true);
  });

  it("does not claim success when the delete control never appears", async () => {
    liveListing(); // menu present, but clicking reveals nothing
    const r = await GT.runDelistFlow(FLOW(), PAYLOAD);
    expect(r.ok).toBe(false);
    expect(r.manual).toBe(true);
    expect(String(r.error)).toMatch(/delete control didn't appear/i);
  });
});

describe("US-1875 AC2: the `gone` witness is inadmissible unless it was there first", () => {
  it("a never-present gone selector must NOT rubber-stamp the delete", async () => {
    document.body.innerHTML = `<div></div>`;
    const flow = FLOW();
    flow.verify = { urlChanged: false, gone: ".never-existed" };
    // goneWasPresent:false — the selector matched nothing before we started, so its
    // "absence" is not evidence. Verifying off it would recreate the false-success
    // bug inside the check meant to prevent it.
    const evidence = await GT.verifyDelist(flow, { startUrl: location.href, goneWasPresent: false }, 200);
    expect(evidence).toBeNull();
  });

  it("a gone selector that WAS present and vanished is evidence", async () => {
    liveListing();
    const flow = FLOW();
    flow.verify = { urlChanged: false, gone: "button.listing-menu" };
    setTimeout(() => document.querySelector("button.listing-menu")?.remove(), 20);
    const evidence = await GT.verifyDelist(flow, { startUrl: location.href, goneWasPresent: true }, 500);
    expect(evidence).toBe("gone");
  });
});

describe("US-1875 AC3: login-wall detection", () => {
  it("detects a login page by its password field", () => {
    document.body.innerHTML = `<form><input type="password" /></form>`;
    expect(GT.isLoginWall({})).toBe(true);
  });

  it("detects a login page by URL pattern", () => {
    document.body.innerHTML = `<div></div>`;
    // jsdom's default URL is localhost, so assert the matcher itself.
    expect(GT.isLoginWall({ urlPattern: "localhost" })).toBe(true);
    expect(GT.isLoginWall({ urlPattern: "poshmark\\.com/login" })).toBe(false);
  });

  it("does NOT mistake a real listing page for a login wall", () => {
    liveListing();
    expect(GT.isLoginWall({ urlPattern: "poshmark\\.com/login" })).toBe(false);
  });

  it("survives a malformed urlPattern instead of throwing mid-job", () => {
    document.body.innerHTML = `<div></div>`;
    expect(GT.isLoginWall({ urlPattern: "([unclosed" })).toBe(false);
  });
});

describe("US-1875: disabled flows stay honest", () => {
  it("an unenabled delist reports manual, never delisted", async () => {
    const flow = FLOW();
    flow.enabled = false;
    const r = await GT.runDelistFlow(flow, PAYLOAD);
    expect(r.ok).toBe(false);
    expect(r.manual).toBe(true);
    expect(r.delisted).toBeUndefined();
  });
});
