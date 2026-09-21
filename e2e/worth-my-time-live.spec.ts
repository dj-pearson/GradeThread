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
