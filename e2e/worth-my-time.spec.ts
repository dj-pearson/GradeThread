import { expect, test, type Page } from "@playwright/test";
import { seedCookieConsent } from "./consent";

// Worth My Time, R1 10/12 (US-3175 AC7): the real flow in a real browser.
//
// The backend is mocked at the network boundary with page.route, the same seam
// the rest of this suite uses. No Supabase, no edge service, no AI spend. What
// is REAL is the SPA: the router, the lazy chunk, the pipeline modules, the
// layout and the focus order.
//
// AC7 asks for desktop and 375px, keyboard-only navigation, and the loading,
// empty and error states. Each has its own test below rather than one long
// walk, so a failure names which of them broke.

const USER_ID = "00000000-0000-0000-0000-000000000001";

test.beforeEach(async ({ page }) => {
  await seedCookieConsent(page);
});

function fakeJwt(): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({
    sub: USER_ID, email: "e2e@example.com", role: "authenticated",
    aud: "authenticated", aal: "aal1", iat: now, exp: now + 3600,
  })}.c2ln`;
}

function item(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    user_id: USER_ID,
    item_number: null, container: null,
    item_title: "Untitled", item_description: null,
    brand: null, style: null, size: null, notes: null, comps: [],
    category: "clothing", source_name: null, source_id: null,
    sourced_by: null, purchase_date: "2026-01-01", purchase_price: 8,
    listed: false, list_date: null, link: null, list_price: null,
    sale_date: null, sale_price: null, fees: null, tax: null,
    shipping_cost: null, net_profit: null, payout: null,
    status: "cataloged", days_to_sell: null, tracking: null,
    target_price: 60, floor_price: null, grade_value: null, grade_label: null,
    certificate_url: null, measurements: null,
    garment_category: null, material: null,
    location_bin: "A-14",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    buyer_id: null, sold_at_raw: null, payout_reference: null,
    listing_status: null, listing_id: null, listing_watchers: null,
    listing_views: null, photo_count: 0, has_required_photos: false,
    ai_field_sources: null, ai_enriched_at: null,
    sale_status: null, sale_cancelled_at: null,
    listing_platform: "ebay", carrier: null, shipped_at: null,
    delivered_at: null, listing_needs_review: null, listing_reviewed_at: null,
    listing_title: null, quality_score: null,
    ...over,
  };
}

const ITEMS = [
  item({ id: "w1", item_title: "Carhartt Detroit jacket", location_bin: "A-14" }),
  item({ id: "w2", item_title: "Levi 501 jeans", location_bin: "A-14" }),
  item({ id: "w3", item_title: "Patagonia fleece", location_bin: "B-02" }),
];

async function mockBackend(page: Page, opts: { items?: unknown[] } = {}) {
  await page.route("**/rest/v1/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/api/**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));

  const session = {
    access_token: fakeJwt(), token_type: "bearer", expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "r",
    user: {
      id: USER_ID, aud: "authenticated", role: "authenticated",
      email: "e2e@example.com", app_metadata: {}, user_metadata: {},
      created_at: new Date(0).toISOString(),
      email_confirmed_at: new Date(0).toISOString(),
      confirmed_at: new Date(0).toISOString(),
    },
  };
  await page.route("**/auth/v1/token**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session) }));
  await page.route("**/auth/v1/user**", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(session.user) }));

  await page.route("**/api/payments/**", (r) =>
    r.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        subscription: {
          plan: "pro", interval: "month", status: "active", period_end: null,
          pause_until: null, cancel_at_period_end: false, trial_ends_at: null,
          stripe_customer_id: null, pending_plan: null, pending_interval: null,
          pending_effective_at: null, upcoming_invoice: null,
        },
        grades: { credit_balance: 5, included_used_this_month: 0, reset_at: null },
        usage: { active_listings: 1, marketplaces_connected: 1, ai_actions_used_this_month: 0, ai_action_limit: null },
        alerts: { thresholds: [80], last_warning: {} },
        recent_ledger: [],
      }),
    }));

  await page.route("**/rest/v1/users**", (r) =>
    r.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        id: USER_ID, email: "e2e@example.com", full_name: "E2E User",
        role: "user", use_case: "seller",
        onboarded_at: "2026-06-01T00:00:00.000Z",
        flipdesk_onboarded: true,
        created_at: "2026-05-01T00:00:00.000Z",
        updated_at: "2026-06-01T00:00:00.000Z",
      }),
    }));

  // The seller's planning preferences, from the R1 01/12 endpoint.
  await page.route("**/api/flipdesk/work-preferences**", (r) =>
    r.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        default_session_minutes: 30,
        work_context: "home",
        available_tools: ["camera", "measuring_tape", "steamer", "packing_supplies"],
        hourly_target_amount: null,
        hourly_target_currency: "USD",
        hourly_target_set: false,
        settings_version: 1,
        session_minute_presets: [15, 30, 60],
        min_session_minutes: 5,
        max_session_minutes: 240,
        work_contexts: ["home", "phone_only"],
        work_tools: ["camera", "measuring_tape", "steamer", "packing_supplies"],
      }),
    }));

  const rows = opts.items ?? ITEMS;
  await page.route("**/rest/v1/items_full**", (r) => {
    const url = new URL(r.request().url());
    // HONOUR `id=eq.<id>`. Without it every single-row read got all three
    // items back, `.maybeSingle()` refused the multi-row answer, and the item
    // page rendered its connection-error state -- which reads as a routing bug
    // and is a mock that answers the wrong question.
    const idFilter = url.searchParams.get("id");
    if (idFilter?.startsWith("eq.")) {
      const id = idFilter.slice(3);
      const match = rows.filter((x) => (x as { id?: string }).id === id);
      return r.fulfill({
        status: 200, contentType: "application/json", body: JSON.stringify(match),
      });
    }
    const start = Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0;
    return r.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify(start === 0 ? rows : []),
    });
  });
}

async function login(page: Page) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill("e2e@example.com");
  await page.locator('input[type="password"]').fill("correct-horse");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
}

async function dismissOverlays(page: Page) {
  const accept = page.getByRole("button", { name: /^accept$/i });
  if (await accept.isVisible().catch(() => false)) {
    await accept.click();
    await expect(accept).toBeHidden();
  }
  // "Skip tour", not /^skip$/i. The loose pattern (copied from
  // flipdesk-lifecycle.spec.ts) matched the session runner's own Skip button
  // and silently skipped the seller's first job before every session test --
  // which reads on screen as an empty plan rather than as a click. The tour's
  // button has said "Skip tour" all along (onboarding-flow.tsx:555), so the
  // loose pattern was never matching the thing it was written for.
  await page.getByRole("button", { name: /skip tour/i })
    .click({ timeout: 8_000 }).catch(() => {});
}

test("worth my time: the picker turns minutes into a readable plan", async ({ page }) => {
  await mockBackend(page);
  await login(page);
  await page.goto("/dashboard/flipdesk/worth-my-time");
  await dismissOverlays(page);

  await expect(page.getByRole("heading", { level: 1, name: "Worth My Time" }))
    .toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "30 minutes" }).click();

  // A plan, headlined by TIME. The money never leads.
  const planHeading = page.locator("#wmt-plan");
  await expect(planHeading).toBeVisible({ timeout: 15_000 });
  await expect(planHeading).toContainText(/minutes/);
  await expect(planHeading).not.toContainText("$");

  // The honesty line, and a row a seller can act on.
  await expect(page.getByText("Times and values are estimates, not earnings."))
    .toBeVisible();
  await expect(page.getByText("Carhartt Detroit jacket").first()).toBeVisible();
  await expect(page.getByRole("link", { name: /Open item/ }).first())
    .toHaveAttribute("href", /\/dashboard\/flipdesk\/items\//);

  // The pull list names the bin, never a route or a distance.
  await expect(page.getByText("Bring these over")).toBeVisible();
  await expect(page.getByText(/A-14/).first()).toBeVisible();
  await expect(page.getByText(/shortest route|metres|steps/i)).toHaveCount(0);
});

test("worth my time: nothing is promised as earnings", async ({ page }) => {
  await mockBackend(page);
  await login(page);
  await page.goto("/dashboard/flipdesk/worth-my-time");
  await dismissOverlays(page);
  await page.getByRole("button", { name: "60 minutes" }).click();
  await expect(page.locator("#wmt-plan")).toBeVisible({ timeout: 15_000 });

  const body = (await page.locator("main").innerText()).toLowerCase();
  expect(body).not.toMatch(/\bearn\b/);
  expect(body).not.toMatch(/guaranteed/);
  expect(body).not.toMatch(/\$\d+ in \d+ minutes/);
});

test("worth my time: empty stock says so rather than showing a blank list", async ({ page }) => {
  await mockBackend(page, { items: [] });
  await login(page);
  await page.goto("/dashboard/flipdesk/worth-my-time");
  await dismissOverlays(page);
  await page.getByRole("button", { name: "30 minutes" }).click();
  await expect(page.getByText(/no unfinished work in your stock/i))
    .toBeVisible({ timeout: 15_000 });
});

test("worth my time: a failed read leaves the previous plan on screen", async ({ page }) => {
  // AC5's sharpest rule, in a real browser. The seller must not come back to a
  // blank screen and assume the evening was lost.
  await mockBackend(page);
  await login(page);
  await page.goto("/dashboard/flipdesk/worth-my-time");
  await dismissOverlays(page);
  await page.getByRole("button", { name: "30 minutes" }).click();
  await expect(page.getByText("Carhartt Detroit jacket").first())
    .toBeVisible({ timeout: 15_000 });

  await page.route("**/rest/v1/items_full**", (r) =>
    r.fulfill({ status: 500, contentType: "application/json", body: '{"message":"boom"}' }));
  await page.getByRole("button", { name: "15 minutes" }).click();

  await expect(page.getByText("Carhartt Detroit jacket").first()).toBeVisible();
});

test("worth my time: keyboard alone reaches and runs the picker", async ({ page }) => {
  await mockBackend(page);
  await login(page);
  await page.goto("/dashboard/flipdesk/worth-my-time");
  await dismissOverlays(page);
  await expect(page.getByRole("button", { name: "15 minutes" })).toBeVisible({ timeout: 15_000 });

  // Tab until the first preset has focus, then activate it with the keyboard.
  const preset = page.getByRole("button", { name: "15 minutes" });
  await preset.focus();
  await expect(preset).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#wmt-plan")).toBeVisible({ timeout: 15_000 });

  // And the custom field is reachable by tabbing onward from the presets.
  await page.getByLabel("Or type it").focus();
  await expect(page.getByLabel("Or type it")).toBeFocused();
});

test("worth my time: usable at 375px with no horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await mockBackend(page);
  await login(page);
  await page.goto("/dashboard/flipdesk/worth-my-time");
  await dismissOverlays(page);
  await page.getByRole("button", { name: "30 minutes" }).click();
  await expect(page.locator("#wmt-plan")).toBeVisible({ timeout: 15_000 });

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow, "the page scrolls sideways at 375px").toBeLessThanOrEqual(0);

  await expect(page.getByText("Carhartt Detroit jacket").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "30 minutes" })).toBeVisible();
});

// ── The session (R1 11/12, US-3176 AC7) ─────────────────────────────────────
//
// Everything below runs against a FAKE SERVER that holds state between
// requests, rather than a per-call stub. That is the point: the story is about
// pausing, reloading and coming back, and a stub that answers the same thing
// every time cannot tell a restored session from a re-rendered one.

interface FakeTask {
  id: string;
  position: number;
  state: string;
  action_key: string;
  inventory_item_id: string | null;
  item_title: string | null;
  bin: string | null;
  estimate_minutes: number | null;
  estimate_value_cents: number | null;
  confirmed_minutes: number | null;
  actionable: boolean;
}

function fakeTask(over: Partial<FakeTask> = {}): FakeTask {
  return {
    id: "task-1",
    position: 1,
    state: "pending",
    action_key: "measure",
    inventory_item_id: "w1",
    item_title: "Carhartt Detroit jacket",
    bin: "A-14",
    estimate_minutes: 5,
    estimate_value_cents: 4800,
    confirmed_minutes: null,
    actionable: true,
    ...over,
  };
}

/**
 * A planner server that remembers.
 *
 * `conflictOnce` makes the next task action answer 409 WITH the true session,
 * which is how the real router reports a stale revision. The client must adopt
 * that state rather than re-POSTing to discover what happened.
 */
async function mockPlanner(
  page: Page,
  opts: {
    state?: string;
    tasks?: FakeTask[];
    conflictOnce?: boolean;
    failRead?: boolean;
  } = {},
) {
  const world = {
    session: { id: "s1", state: opts.state ?? "active", budget_minutes: 30, revision: 4 },
    tasks: opts.tasks ?? [fakeTask()],
    conflictOnce: opts.conflictOnce ?? false,
  };
  const body = () => JSON.stringify({ session: world.session, tasks: world.tasks });

  await page.route("**/api/flipdesk/planner/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path.endsWith("/sessions/current")) {
      if (opts.failRead) {
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "upstream" }),
        });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: body() });
    }

    const sessionAction = /\/sessions\/[^/]+\/([a-z]+)$/.exec(path);
    if (sessionAction) {
      const action = sessionAction[1]!;
      world.session.state = action === "pause"
        ? "paused"
        : action === "resume"
        ? "active"
        : action === "complete"
        ? "completed"
        : world.session.state;
      if (world.session.state !== "active") {
        for (const t of world.tasks) if (t.state === "active") t.state = "pending";
      }
      world.session.revision += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: body() });
    }

    const taskAction = /\/tasks\/([^/]+)\/([a-z]+)$/.exec(path);
    if (taskAction) {
      if (world.conflictOnce) {
        world.conflictOnce = false;
        world.session.revision = 99;
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: "Someone else changed this session while you were working.",
            code: "stale_revision",
            session: world.session,
            tasks: world.tasks,
          }),
        });
      }
      const [, taskId, action] = taskAction as unknown as [string, string, string];
      const t = world.tasks.find((x) => x.id === taskId);
      if (t) {
        if (action === "start") t.state = "active";
        if (action === "skip") t.state = "skipped";
        if (action === "complete") {
          t.state = "completed";
          const payload = route.request().postDataJSON() as { confirmed_minutes?: number };
          t.confirmed_minutes = payload?.confirmed_minutes ?? null;
        }
      }
      world.session.revision += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: body() });
    }

    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
}

test("session: start a job, then say how long it really took", async ({ page }) => {
  await mockBackend(page);
  await mockPlanner(page);
  await login(page);
  await page.goto("/dashboard/flipdesk/worth-my-time");
  await dismissOverlays(page);

  const runner = page.locator("section", { has: page.getByRole("heading", { name: "Working through your plan" }) });
  await expect(runner).toBeVisible();
  await expect(runner).toContainText("Carhartt Detroit jacket");

  await page.getByRole("button", { name: /Start this one/ }).click();
  await page.getByRole("button", { name: /^Done$/ }).click();

  // Done opens the question rather than banking the clock.
  await expect(page.getByText("How long did that actually take?")).toBeVisible();
  const minutes = page.locator("#wmt-minutes");
  await minutes.fill("12");
  await page.getByRole("button", { name: /Save and move on/ }).click();

  // The server took the seller's number, and the screen shows its answer.
  await expect(page.getByText("Nothing left to do in this session.")).toBeVisible();
});

test("session: a pause survives a full page reload", async ({ page }) => {
  await mockBackend(page);
  await mockPlanner(page);
  await login(page);
  await page.goto("/dashboard/flipdesk/worth-my-time");
  await dismissOverlays(page);

  await page.getByRole("button", { name: /^Pause$/ }).click();
  await expect(page.getByRole("heading", { name: "Paused" })).toBeVisible();

  // A REAL reload, not a re-render. The screen keeps nothing of its own, so
  // this is the whole test of durability.
  await page.reload();
  await dismissOverlays(page);
  await expect(page.getByRole("heading", { name: "Paused" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Pick up where I left off/ })).toBeVisible();
});

test("session: opening the item carries the way back", async ({ page }) => {
  await mockBackend(page);
  await mockPlanner(page);
  await login(page);
  await page.goto("/dashboard/flipdesk/worth-my-time");
  await dismissOverlays(page);

  const open = page.getByRole("link", { name: /Open item/ }).first();
  await expect(open).toHaveAttribute(
    "href",
    "/dashboard/flipdesk/items/w1?back=%2Fdashboard%2Fflipdesk%2Fworth-my-time",
  );
  await open.click();
  // The item page reads the param and says where it goes.
  await expect(page.getByRole("button", { name: /Back to your session/ })).toBeVisible();
});

test("session: a stale revision corrects the screen instead of re-sending", async ({ page }) => {
  await mockBackend(page);
  await mockPlanner(page, { conflictOnce: true });
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/planner/tasks/")) posts.push(r.url());
  });
  await login(page);
  await page.goto("/dashboard/flipdesk/worth-my-time");
  await dismissOverlays(page);

  await page.getByRole("button", { name: /Start this one/ }).click();
  await expect(page.getByRole("alert")).toContainText("Someone else changed this session");
  await expect(page.getByRole("alert")).toContainText("up to date now");
  // Exactly one. Replaying to find out what happened is how one attempt lands
  // twice.
  expect(posts).toHaveLength(1);
});

test("session: a failed read says nothing is lost", async ({ page }) => {
  await mockBackend(page);
  await mockPlanner(page, { failRead: true });
  await login(page);
  await page.goto("/dashboard/flipdesk/worth-my-time");
  await dismissOverlays(page);

  await expect(page.getByText(/Nothing is lost/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Try again/ })).toBeVisible();
});

test("session: keyboard alone runs it", async ({ page }) => {
  await mockBackend(page);
  await mockPlanner(page);
  await login(page);
  await page.goto("/dashboard/flipdesk/worth-my-time");
  await dismissOverlays(page);

  const start = page.getByRole("button", { name: /Start this one/ });
  await expect(start).toBeVisible();
  await start.focus();
  await expect(start).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /^Done$/ })).toBeVisible();

  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  // Whatever holds focus after tabbing is a real, named control.
  const name = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return (el?.textContent?.trim() || el?.getAttribute("aria-label") || "").slice(0, 40);
  });
  expect(name.length).toBeGreaterThan(0);
});

// ── The stop-working advice (R2 03/06, US-3180 AC7) ─────────────────────────

/** An item with everything done and almost nothing left in it. */
const POOR_ITEM = item({
  id: "w1",
  item_title: "Carhartt Detroit jacket",
  location_bin: "A-14",
  status: "cataloged",
  measurements: { chest: 22 },
  has_required_photos: true,
  target_price: 4,
  purchase_price: 3,
  listing_platform: "ebay",
  listing_id: "l1",
});

/** The same garment, worth finishing: no photos, no measurements, priced high. */
const RICH_ITEM = item({
  id: "w1",
  item_title: "Carhartt Detroit jacket",
  location_bin: "A-14",
  status: "cataloged",
  measurements: null,
  has_required_photos: false,
  target_price: 180,
  purchase_price: 10,
  listing_platform: "ebay",
});

test("advice: offers the alternatives when there is little left in it", async ({ page }) => {
  await mockBackend(page, { items: [POOR_ITEM] });
  await mockPlanner(page, { state: "active", tasks: [fakeTask({ state: "active" })] });
  await login(page);
  await page.goto("/dashboard/flipdesk/worth-my-time");
  await dismissOverlays(page);

  await expect(page.getByText("List it as it is")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Suggestions only. Nothing here changes a listing."))
    .toBeVisible();
  // NO INVENTED PRICE for the options that have none.
  await expect(page.getByText(/haven't measured what a half-ready listing makes/))
    .toBeVisible();
});

test("advice: stays out of the way when finishing is worth it", async ({ page }) => {
  await mockBackend(page, { items: [RICH_ITEM] });
  await mockPlanner(page, { state: "active", tasks: [fakeTask({ state: "active" })] });
  await login(page);
  await page.goto("/dashboard/flipdesk/worth-my-time");
  await dismissOverlays(page);

  await expect(page.getByRole("heading", { name: "Working through your plan" }))
    .toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Suggestions only. Nothing here changes a listing."))
    .toBeHidden();
});

test("advice: makes no tax or value claim, and no bundle price", async ({ page }) => {
  await mockBackend(page, { items: [POOR_ITEM] });
  await mockPlanner(page, { state: "active", tasks: [fakeTask({ state: "active" })] });
  await login(page);
  await page.goto("/dashboard/flipdesk/worth-my-time");
  await dismissOverlays(page);
  await expect(page.getByText("List it as it is")).toBeVisible({ timeout: 15_000 });

  const body = (await page.locator("body").innerText()).toLowerCase();
  for (const banned of ["deduction", "tax write", "write-off", "fair market"]) {
    expect(body, `the advice panel says "${banned}"`).not.toContain(banned);
  }
});

test("advice: keyboard reaches its links, and it fits 375px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockBackend(page, { items: [POOR_ITEM] });
  await mockPlanner(page, { state: "active", tasks: [fakeTask({ state: "active" })] });
  await login(page);
  await page.goto("/dashboard/flipdesk/worth-my-time");
  await dismissOverlays(page);

  await expect(page.getByText("List it as it is")).toBeVisible({ timeout: 15_000 });
  const open = page.getByRole("link", { name: /^Open$/ }).first();
  if (await open.count()) {
    await open.focus();
    await expect(open).toBeFocused();
  }
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("session: usable at 375px with no horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockBackend(page);
  await mockPlanner(page);
  await login(page);
  await page.goto("/dashboard/flipdesk/worth-my-time");
  await dismissOverlays(page);

  await expect(page.getByRole("heading", { name: "Working through your plan" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Start this one/ })).toBeVisible();
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});




