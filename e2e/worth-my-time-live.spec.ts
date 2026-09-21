import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { seedCookieConsent } from "./consent";

// Worth My Time against a REAL STACK (US-3177 AC1, AC6).
//
// NOTHING HERE IS MOCKED. No page.route, no fulfilled responses, no fixture
// JSON. The browser signs in, the SPA reads the seller's stock through
// PostgREST under RLS, the pipeline runs over those rows, the session is
// created by the edge service and persisted in Postgres, and a reload reads it
// back out. The companion file worth-my-time.spec.ts mocks the boundary and
// runs anywhere; this one proves the pieces agree with each other, which a
// mock cannot do by construction.
//
// WHAT IT NEEDS, and why it is skipped rather than failed when absent:
//   - Postgres with the migrations applied
//   - PostgREST, fronted by a Supabase-shaped proxy on $LIVE_SUPABASE_URL
//   - the edge service on $LIVE_EDGE_URL
//   - a seeded seller whose email is $LIVE_EMAIL
//   - the SPA BUILT against those two URLs (VITE_SUPABASE_URL /
//     VITE_EDGE_API_URL), because they are baked in at build time
// A developer without the stack gets a skip with the reason. A red test for a
// missing environment is a red nobody reads, which is the failure mode this
// repo keeps paying for.
//
// The recipe lives in the US-3177 story note.

const EDGE = process.env.LIVE_EDGE_URL;
const SUPA = process.env.LIVE_SUPABASE_URL;
const EMAIL = process.env.LIVE_EMAIL;
const OTHER_EMAIL = process.env.LIVE_OTHER_EMAIL;
const READY = Boolean(EDGE && SUPA && EMAIL);

test.skip(
  !READY,
  "live stack not configured: set LIVE_EDGE_URL, LIVE_SUPABASE_URL and " +
    "LIVE_EMAIL, and build the SPA against the same two URLs",
);

// THE BROWSER MUST NOT SEND LOOPBACK THROUGH THE EGRESS PROXY. In this
// environment HTTPS_PROXY is set for the whole session, Chromium inherits it,
// and every call to the local stack came back ERR_TUNNEL_CONNECTION_FAILED --
// which surfaced on the login screen as "We couldn't reach the server" and
// reads exactly like a broken stack.
test.use({ launchOptions: { args: ["--proxy-bypass-list=<-loopback>;127.0.0.1;localhost"] } });

test.beforeEach(async ({ page }) => {
  await seedCookieConsent(page);
});

async function signIn(page: Page, email = EMAIL!) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill("local-only");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
}

async function dismissOverlays(page: Page) {
  const accept = page.getByRole("button", { name: /^accept$/i });
  if (await accept.isVisible().catch(() => false)) {
    await accept.click();
    await expect(accept).toBeHidden();
  }
  await page.getByRole("button", { name: /skip tour/i })
    .click({ timeout: 8_000 }).catch(() => {});
}

/**
 * Leave no session behind.
 *
 * One open session per seller is the rule (00819), so a test that finished
 * mid-session would make the next one fail for a reason that has nothing to do
 * with what it is testing. Done over the API rather than through the UI: this
 * is teardown, not a thing under test.
 */
async function clearSessions(page: Page) {
  await page.evaluate(async (edge) => {
    const raw = Object.keys(localStorage)
      .filter((k) => k.includes("auth-token"))
      .map((k) => localStorage.getItem(k))
      .find(Boolean);
    if (!raw) return;
    const token = JSON.parse(raw).access_token as string;
    const h = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    for (let i = 0; i < 5; i += 1) {
      const cur = await fetch(`${edge}/api/flipdesk/planner/sessions/current`, { headers: h });
      const body = await cur.json();
      const s = body?.session;
      if (!s || ["completed", "abandoned"].includes(s.state)) return;
      let done = false;
      for (const action of ["complete", "abandon"]) {
        const res = await fetch(
          `${edge}/api/flipdesk/planner/sessions/${s.id}/${action}`,
          { method: "POST", headers: h, body: JSON.stringify({ revision: s.revision }) },
        );
        if (res.ok) { done = true; break; }
      }
      if (!done) return;
    }
  }, EDGE!);
}

test("live: real stock becomes a real plan", async ({ page }) => {
  await signIn(page);
  await clearSessions(page);
  await page.goto("/dashboard/flipdesk/worth-my-time");
  await dismissOverlays(page);

  await expect(page.getByRole("heading", { level: 1, name: "Worth My Time" })).toBeVisible();
  await page.getByRole("button", { name: "30 minutes" }).click();

  // The plan is built from rows that came out of Postgres through RLS.
  await expect(page.getByRole("heading", { name: /jobs?, about \d+ minutes/ }))
    .toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Carhartt Detroit jacket").first()).toBeVisible();

  // SOURCE-STATE COMPLETION IS RESPECTED (AC2). The Patagonia is seeded
  // `measured` with real measurements, so the plan must not ask for them
  // again. It may legitimately appear for the NEXT step, so the assertion is
  // on the pairing rather than on the item's absence.
  const rows = await page.locator("ol > li").allInnerTexts();
  const patagonia = rows.find((r) => r.includes("Patagonia Synchilla"));
  if (patagonia) expect(patagonia).not.toContain("Measure —");

  // NO FOREIGN DATA (AC2). Mallory's garment is one RLS predicate away.
  await expect(page.locator("body")).not.toContainText("MALLORY SECRET COAT");

  await expect(page.getByText("Times and values are estimates, not earnings.")).toBeVisible();
  await clearSessions(page);
});

test("live: start a session, work a job, and reload into it", async ({ page }) => {
  await signIn(page);
  await clearSessions(page);
  await page.goto("/dashboard/flipdesk/worth-my-time");
  await dismissOverlays(page);

  await page.getByRole("button", { name: "30 minutes" }).click();
  await page.getByRole("button", { name: /Start working through this/ })
    .click({ timeout: 15_000 });

  const runner = page.getByRole("heading", { name: "Working through your plan" });
  await expect(runner).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: /Start this one/ }).click();
  await expect(page.getByRole("button", { name: /^Done$/ })).toBeVisible();

  // THE RELOAD IS THE POINT. Nothing in the browser remembers this; it comes
  // back out of the database.
  await page.reload();
  await dismissOverlays(page);
  await expect(page.getByRole("heading", { name: "Working through your plan" }))
    .toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: /^Done$/ })).toBeVisible();

  await page.getByRole("button", { name: /^Done$/ }).click();
  await expect(page.getByText("How long did that actually take?")).toBeVisible();
  await page.locator("#wmt-minutes").fill("9");
  await page.getByRole("button", { name: /Save and move on/ }).click();

  // One job done, and the minutes are the ones the seller typed.
  await expect(page.getByText(/1 done/)).toBeVisible({ timeout: 15_000 });
  await clearSessions(page);
});

test("live: a pause survives a reload, and finishing keeps the rest", async ({ page }) => {
  await signIn(page);
  await clearSessions(page);
  await page.goto("/dashboard/flipdesk/worth-my-time");
  await dismissOverlays(page);

  await page.getByRole("button", { name: "30 minutes" }).click();
  await page.getByRole("button", { name: /Start working through this/ })
    .click({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Working through your plan" }))
    .toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: /Start this one/ }).click();
  await page.getByRole("button", { name: /^Pause$/ }).click();
  await expect(page.getByRole("heading", { name: "Paused" })).toBeVisible();

  await page.reload();
  await dismissOverlays(page);
  await expect(page.getByRole("heading", { name: "Paused" })).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: /Pick up where I left off/ }).click();
  await expect(page.getByRole("heading", { name: "Working through your plan" })).toBeVisible();

  await page.getByRole("button", { name: /Finish for now/ }).click();
  // AC5: unfinished work is kept, and the summary says so rather than
  // reporting a projected value as something earned.
  await expect(page.getByText(/left for next time/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Nothing was lost/)).toBeVisible();
  const summary = await page.locator("body").innerText();
  for (const word of ["earned", "you made", "profit"]) {
    expect(summary.toLowerCase()).not.toContain(word);
  }
  await clearSessions(page);
});

test("live: the item link opens the real item and comes back", async ({ page }) => {
  await signIn(page);
  await clearSessions(page);
  await page.goto("/dashboard/flipdesk/worth-my-time");
  await dismissOverlays(page);

  await page.getByRole("button", { name: "30 minutes" }).click();
  const open = page.getByRole("link", { name: /Open item/ }).first();
  await expect(open).toBeVisible({ timeout: 15_000 });
  await open.click();

  // A real item page, loaded from a real row, with the way back.
  await expect(page).toHaveURL(/\/dashboard\/flipdesk\/items\/[0-9a-f-]+/);
  const back = page.getByRole("button", { name: /Back to your session/ });
  await expect(back.first()).toBeVisible({ timeout: 20_000 });
  await back.first().click();
  await expect(page).toHaveURL(/worth-my-time/);
  await clearSessions(page);
});

test("live: the other seller sees none of it", async ({ page }) => {
  test.skip(!OTHER_EMAIL, "set LIVE_OTHER_EMAIL to run the isolation case");
  await signIn(page, OTHER_EMAIL!);
  await page.goto("/dashboard/flipdesk/worth-my-time");
  await dismissOverlays(page);
  await page.getByRole("button", { name: "30 minutes" }).click();
  await page.waitForTimeout(2_000);

  const body = await page.locator("body").innerText();
  // Every one of the first seller's garments, by name. RLS is the only thing
  // standing between these two, and this is the browser asking it.
  for (const title of [
    "Carhartt Detroit jacket",
    "Levi 501 jeans",
    "Patagonia Synchilla",
    "Unbranded fleece",
  ]) {
    expect(body, `the other seller can see "${title}"`).not.toContain(title);
  }
});

test("live: usable at 375px with no horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await signIn(page);
  await clearSessions(page);
  await page.goto("/dashboard/flipdesk/worth-my-time");
  await dismissOverlays(page);

  await page.getByRole("button", { name: "30 minutes" }).click();
  await expect(page.getByRole("heading", { name: /jobs?, about \d+ minutes/ }))
    .toBeVisible({ timeout: 15_000 });
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await clearSessions(page);
});

// ── R2 05/06 (US-3182): correcting and setting aside ─────────────────────────
//
// Same stack, same rules: the corrections are written by the edge into
// Postgres and read back through the API, and the plan is rebuilt from them.
// The one exception is the error case at the bottom, which aborts a single
// request on purpose because there is no honest way to make a live route fail
// from the UI; it is marked where it happens.

/** Leave no correction behind, for the same reason clearSessions exists. */
async function clearCorrections(page: Page) {
  await page.evaluate(async (edge) => {
    const raw = Object.keys(localStorage)
      .filter((k) => k.includes("auth-token"))
      .map((k) => localStorage.getItem(k))
      .find(Boolean);
    if (!raw) return;
    const token = JSON.parse(raw).access_token as string;
    const h = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const res = await fetch(`${edge}/api/flipdesk/planner/overrides`, { headers: h });
    if (!res.ok) return;
    const body = await res.json();
    const ids = new Set<string>([
      ...(body.overrides ?? []).map((o: { inventory_item_id: string }) => o.inventory_item_id),
      ...(body.suppressions ?? []).map((s: { inventory_item_id: string }) => s.inventory_item_id),
    ]);
    for (const id of ids) {
      for (const kind of ["task_minutes", "value_range", "remaining_cost"]) {
        await fetch(`${edge}/api/flipdesk/planner/overrides/reset`, {
          method: "POST",
          headers: h,
          body: JSON.stringify({ inventory_item_id: id, kind }),
        });
      }
      await fetch(`${edge}/api/flipdesk/planner/suppressions/reset`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ inventory_item_id: id }),
      });
    }
  }, EDGE!);
}

/**
 * The plan's own list.
 *
 * NOT `page.locator("ol")`: sonner renders its toaster as an <ol> as well, so
 * a bare selector is a strict-mode violation the moment a toast appears --
 * which is exactly when these tests look.
 */
function planList(page: Page) {
  return page.getByRole("region", { name: /jobs?, about \d+ minutes/ }).locator("ol");
}

/** Set the seller's work setup, the way the preferences screen does. */
async function setPreferences(page: Page, patch: Record<string, unknown>) {
  await page.evaluate(async ([edge, body]) => {
    const raw = Object.keys(localStorage)
      .filter((k) => k.includes("auth-token"))
      .map((k) => localStorage.getItem(k))
      .find(Boolean);
    const token = JSON.parse(raw!).access_token as string;
    const res = await fetch(`${edge}/api/flipdesk/work-preferences`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`preferences PATCH ${res.status}`);
  }, [EDGE!, patch] as const);
}

/** One item's own row, straight from PostgREST under the seller's own RLS. */
async function readItem(page: Page, id: string) {
  return await page.evaluate(async ([supa, itemId]) => {
    const raw = Object.keys(localStorage)
      .filter((k) => k.includes("auth-token"))
      .map((k) => localStorage.getItem(k))
      .find(Boolean);
    const token = JSON.parse(raw!).access_token as string;
    const res = await fetch(
      `${supa}/rest/v1/inventory_items?id=eq.${itemId}&select=id,status,title,target_price`,
      { headers: { Authorization: `Bearer ${token}`, apikey: token } },
    );
    const rows = await res.json();
    // LOUD, not undefined. The first version selected a column that is not on
    // this table, PostgREST answered a 42703 object, `rows[0]` was undefined,
    // and `expect(after).toEqual(before)` then compared undefined with
    // undefined and passed. A read that cannot read must say so.
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new Error(`item read failed: ${JSON.stringify(rows)}`);
    }
    return rows[0] as Record<string, unknown>;
  }, [SUPA!, id] as const);
}

async function planFor(page: Page, minutes = "30 minutes") {
  await page.goto("/dashboard/flipdesk/worth-my-time");
  await dismissOverlays(page);
  await page.getByRole("button", { name: minutes }).click();
  await expect(page.getByRole("heading", { name: /jobs?, about \d+ minutes/ }))
    .toBeVisible({ timeout: 15_000 });
}

test("live: a correction is stored, survives a reload and changes the next plan", async ({ page }) => {
  await signIn(page);
  await clearSessions(page);
  await clearCorrections(page);
  await planFor(page);

  const firstRow = planList(page).locator("> li").first();
  // The FIRST LINE only. Opening the panel below adds its controls to the
  // row's innerText, so comparing the whole thing would compare the panel
  // with itself closed.
  const before = (await firstRow.innerText()).split("\n")[0]!;
  await firstRow.getByText("Change or set aside").click();

  const field = firstRow.locator('input[id^="min-"]');
  await field.fill("47");

  // AC2: the difference is on screen BEFORE anything is written.
  await expect(firstRow.getByText(/We said about \d+ min\. You're saying 47\./))
    .toBeVisible();

  await firstRow.getByRole("button", { name: "Save" }).first().click();

  // AC2 again: the plan on screen is NOT replaced under the seller. It says it
  // is out of date and offers the button.
  await expect(page.getByText(/You changed something since this plan was built/))
    .toBeVisible({ timeout: 15_000 });
  expect((await planList(page).locator("> li").first().innerText()).split("\n")[0])
    .toBe(before);

  // THE RELOAD IS THE POINT. The correction comes back out of the database.
  await page.reload();
  await dismissOverlays(page);
  await page.getByRole("button", { name: "30 minutes" }).click();
  await expect(page.getByRole("heading", { name: /jobs?, about \d+ minutes/ }))
    .toBeVisible({ timeout: 15_000 });
  await expect(planList(page).locator("> li").first()).toContainText("about 47 min");

  // And reset puts our estimate back.
  const row = planList(page).locator("> li").first();
  await row.getByText("Change or set aside").click();
  await row.getByRole("button", { name: "Use our estimate" }).click();
  await page.getByRole("button", { name: "Build it again" }).click();
  await expect(planList(page).locator("> li").first())
    .not.toContainText("about 47 min", { timeout: 15_000 });

  await clearCorrections(page);
});

test("live: a dismissal takes the job out of the next plan, and can be undone", async ({ page }) => {
  await signIn(page);
  await clearSessions(page);
  await clearCorrections(page);
  await planFor(page);

  const row = planList(page).locator("> li").first();
  const title = (await row.innerText()).split("\n")[0]!;
  const href = await row.getByRole("link", { name: /Open item/ }).getAttribute("href");
  // itemHref carries a `?back=` so the item screen can return here, so the
  // last path segment is not the id on its own.
  const itemId = href!.split("?")[0]!.split("/").pop()!;
  const before = await readItem(page, itemId);
  await row.getByText("Change or set aside").click();

  // AC3: the panel says out loud that nothing is sold, archived or deleted.
  await expect(row.getByText(/Your item stays where it is/)).toBeVisible();
  await row.getByRole("button", { name: "Stop suggesting this" }).click();

  await page.getByRole("button", { name: "Build it again" }).click();
  await expect(page.getByText(/jobs? (is|are) set aside/)).toBeVisible({ timeout: 15_000 });
  expect(await planList(page).innerText()).not.toContain(title);

  // ⚠ THE GARMENT ITSELF IS UNTOUCHED. Read straight out of Postgres rather
  // than off a screen: "it still shows on the inventory page" is a weaker
  // claim than "the row has the same status it had", and the inventory screen
  // renders the same title in two layouts with one hidden per breakpoint, so
  // a visibility assertion there measures CSS. A set-aside that quietly sold
  // or archived stock would be the worst bug this feature could ship.
  const after = await readItem(page, itemId);
  expect(after.id).toBe(itemId);
  expect(after).toEqual(before);
  expect(after.status).not.toBe("archived");
  expect(after.status).not.toBe("sold");

  await clearCorrections(page);
});

test("live: a bad number is refused with a sentence, and nothing is written", async ({ page }) => {
  await signIn(page);
  await clearSessions(page);
  await clearCorrections(page);
  await planFor(page);

  const row = planList(page).locator("> li").first();
  await row.getByText("Change or set aside").click();
  await row.locator('input[id^="min-"]').fill("0");
  await row.getByRole("button", { name: "Save" }).first().click();
  await expect(row.getByText("Zero minutes isn't a real answer. Put at least one."))
    .toBeVisible();

  await row.locator('input[id^="min-"]').fill("6000");
  await row.getByRole("button", { name: "Save" }).first().click();
  await expect(row.getByText(/longer than a whole session/)).toBeVisible();

  // Nothing reached the server: the plan is not marked out of date.
  await expect(page.getByText(/You changed something since this plan was built/))
    .toHaveCount(0);

  await clearCorrections(page);
});

test("live: the panel works at 375px and from the keyboard alone", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 760 });
  await signIn(page);
  await clearSessions(page);
  await clearCorrections(page);
  await planFor(page);

  const row = planList(page).locator("> li").first();
  const summary = row.getByText("Change or set aside");

  // KEYBOARD ONLY from here. <details><summary> is focusable and toggles on
  // Enter with no handler of ours, which is the reason it is a disclosure
  // rather than a dialog.
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(row.locator('input[id^="min-"]')).toBeVisible();

  await page.keyboard.press("Tab");
  await expect(row.locator('input[id^="min-"]')).toBeFocused();
  await page.keyboard.type("25");
  await expect(row.getByText(/You're saying 25\./)).toBeVisible();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/You changed something since this plan was built/))
    .toBeVisible({ timeout: 15_000 });

  // Nothing runs off the side of a phone.
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);

  await clearCorrections(page);
});

test("live: a failed save says so and keeps what was typed", async ({ page }) => {
  await signIn(page);
  await clearSessions(page);
  await clearCorrections(page);
  await planFor(page);

  // ⚠ THE ONE MOCKED THING IN THIS FILE, and only this request. There is no
  // honest way to make a live route fail from the UI, and "the network dropped
  // mid-correction" is a state AC7 names.
  await page.route("**/api/flipdesk/planner/overrides", (r) =>
    r.fulfill({ status: 500, body: JSON.stringify({ error: "nope" }) })
  );

  const row = planList(page).locator("> li").first();
  await row.getByText("Change or set aside").click();
  await row.locator('input[id^="min-"]').fill("33");
  await row.getByRole("button", { name: "Save" }).first().click();

  // US-2869 owns the wording: a 500 is classified and the call site's own
  // sentence is only one input to it, so the assertion is on the CLASS of
  // message rather than on the fallback string this file passes in.
  await expect(page.getByRole("region", { name: /Notifications/ }))
    .toContainText(/Something broke on our side|Couldn't save that correction/, {
      timeout: 15_000,
    });
  // The typed number is still there: a failed save must not also lose the work.
  await expect(row.locator('input[id^="min-"]')).toHaveValue("33");

  await page.unroute("**/api/flipdesk/planner/overrides");
  await clearCorrections(page);
});

// ── R2 06/06 (US-3183): the results view ─────────────────────────────────────
//
// The scorecard reads four tables, so these cases need rows in them. They use
// the SAME fixture scripts/check-scorecard-e2e.mjs seeds -- one definition,
// rather than a second one that drifts from it -- and they skip cleanly when
// LIVE_DSN is absent, because a red test for a missing environment is a red
// nobody reads.

const DSN = process.env.LIVE_DSN;
const USER_A = process.env.LIVE_USER_A ?? "11111111-1111-1111-1111-111111111111";
const USER_B = process.env.LIVE_USER_B ?? "22222222-2222-2222-2222-222222222222";

function fixture(mode: "--seed-only" | "--cleanup-only") {
  execFileSync("node", [
    "scripts/check-scorecard-e2e.mjs", mode,
    "--user-a", USER_A, "--user-b", USER_B, "--dsn", DSN!,
  ], { encoding: "utf8" });
}

test.describe("the results view", () => {
  test.skip(!DSN, "set LIVE_DSN to seed the scorecard fixture");

  test.beforeAll(() => fixture("--seed-only"));
  test.afterAll(() => fixture("--cleanup-only"));

  async function openResults(page: Page) {
    await page.goto("/dashboard/flipdesk/worth-my-time");
    await dismissOverlays(page);
    const summary = page.getByText("How the planner has done for you");
    await summary.click();
    // The fixture's work was planned in January, so the range is pointed at
    // it: the default 90-day window would also pick up whatever the other
    // live cases left behind, and the numbers below would stop being
    // falsifiable.
    await page.locator("#wmt-from").fill("2026-01-01");
    await page.locator("#wmt-to").fill("2026-01-31");
  }

  test("live: the three figures come out of real rows and are never one figure", async ({ page }) => {
    await signIn(page);
    await openResults(page);

    // 6 garments planned in January; the money below is the books' own net.
    // jacket 80 - 1.50 fees - 22 basis = 56.50
    // fleece 20 - 1.50 - 4 = 14.50 (the cancelled cross-post is not counted)
    // windbreaker 28 - 1.50 - 9 = 17.50
    // synchilla REFUNDED 35 - 1.50 - 18 = 15.50, restated rather than dropped
    // jeans: no acquired_price, so it is left out and said so
    // EXACT, because the forecast sentence below repeats these figures in
    // prose and a loose match is a strict-mode violation rather than a result.
    await expect(page.getByText("What the books recorded")).toBeVisible();
    await expect(page.getByText("$104.00", { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // The projection is a separate box and is NOT added to it. Six garments
    // were planned in the window; every one carries an estimate.
    await expect(page.getByText("What the planner guessed")).toBeVisible();
    await expect(page.getByText("$198.00", { exact: true })).toBeVisible();

    // 30 + 20 + 10 + 12 + 0 = 72 minutes against the four settled garments.
    // $104.00 over 72 minutes is $86.67 an hour.
    await expect(page.getByText("Profit per tracked hour")).toBeVisible();
    await expect(page.getByText("$86.67", { exact: true })).toBeVisible();
    await expect(page.getByText(/Only counts minutes you confirmed/)).toBeVisible();
  });

  test("live: a garment planned twice is one sale, and a cross-post is not a second", async ({ page }) => {
    await signIn(page);
    await openResults(page);
    // 5 settled garments: 4 counted + 1 left out for missing costs. If the
    // duplicate session or the cancelled cross-post were counted again this
    // would read 6 or 7.
    await expect(page.getByText("On 4 items")).toBeVisible({ timeout: 15_000 });
  });

  test("live: an unrecorded cost is named, not treated as free money", async ({ page }) => {
    await signIn(page);
    await openResults(page);
    await expect(page.getByText(/1 sold item is left out above/)).toBeVisible({
      timeout: 15_000,
    });
  });

  test("live: unsold work sits beside the wins with its hours", async ({ page }) => {
    await signIn(page);
    await openResults(page);
    await expect(page.getByText("Still waiting to sell")).toBeVisible({ timeout: 15_000 });
    // The overcoat: 25 minutes measured, then the photograph skipped.
    await expect(page.getByText(/1 item, with 25 min already in them/)).toBeVisible();
    await expect(page.getByText(/1 item carried into another evening/)).toBeVisible();
  });

  test("live: an empty window reports no work, not a row of zeroes", async ({ page }) => {
    await signIn(page);
    await openResults(page);
    await page.locator("#wmt-from").fill("2025-01-01");
    await page.locator("#wmt-to").fill("2025-01-31");
    await expect(page.getByText("No planned work in these dates.").first())
      .toBeVisible({ timeout: 15_000 });
  });

  test("live: it claims no cause, and never says earned or saved", async ({ page }) => {
    await signIn(page);
    await openResults(page);
    await page.getByRole("button", { name: /Compare with the period before/ }).click();
    await expect(page.getByText(/doesn't show that one caused the other/))
      .toBeVisible({ timeout: 15_000 });

    const text = await page.locator("main").innerText();
    for (const banned of [/\bearn/i, /\bsaved\b/i, /guaranteed/i, /your hourly rate/i]) {
      expect(banned.test(text), `page matched ${banned}`).toBe(false);
    }
  });

  test("live: the panel works at 375px and from the keyboard alone", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 760 });
    await signIn(page);
    await page.goto("/dashboard/flipdesk/worth-my-time");
    await dismissOverlays(page);

    const summary = page.getByText("How the planner has done for you");
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#wmt-from")).toBeVisible();
    // ⚠ NOT a single Tab between the two date fields. <input type="date"> is
    // three focusable segments in Chromium, so Tab walks day/month/year
    // before it leaves the control -- the first version of this case asserted
    // one press and failed on a correct page. What matters is that the
    // keyboard REACHES everything, so it walks forward until it does.
    await page.locator("#wmt-from").focus();
    const reached: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press("Tab");
      const id = await page.evaluate(() => document.activeElement?.id ?? "");
      const label = await page.evaluate(() =>
        document.activeElement?.tagName === "BUTTON"
          ? (document.activeElement.textContent ?? "").trim()
          : ""
      );
      if (id) reached.push(id);
      if (/Compare with/.test(label)) reached.push("compare");
    }
    expect(reached).toContain("wmt-to");
    expect(reached).toContain("compare");

    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("live: a plan still builds for a seller with no learned history (AC6)", async ({ page }) => {
    // The fixture gives Mallory one planned garment and no confirmed history,
    // which is the shape of a seller's first evening: the estimator has
    // nothing to learn from, so the plan must fall back to its labelled
    // defaults rather than failing or showing a blank.
    await signIn(page, OTHER_EMAIL ?? "");
    await clearSessions(page);
    // ⚠ FIRST THEY SAY WHERE THEY ARE WORKING. This seller is seeded
    // phone-only with a camera, and measuring needs a table and a tape -- so
    // the honest first run is "nothing fits that window", which is the
    // candidate builder working rather than a plan failing. The first version
    // of this case read that as a broken plan.
    await setPreferences(page, { work_context: "home", available_tools: ["camera", "measuring_tape"] });
    await page.goto("/dashboard/flipdesk/worth-my-time");
    await dismissOverlays(page);
    await page.getByRole("button", { name: "30 minutes" }).click();
    await expect(page.getByRole("heading", { name: /jobs?, about \d+ minutes/ }))
      .toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Scorecard other-seller coat").first()).toBeVisible();
    await clearSessions(page);
  });
});
