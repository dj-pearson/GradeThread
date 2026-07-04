// US-1579: MeasureCard distribution — CSV export purity + the PII/tenancy
// source contracts on both the seller and operator routes.
//
//   deno test --allow-env --allow-read src/tests/admin-measure-cards_test.ts

import { assert, assertEquals } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { csvCell, requestsToCsv } = await import(
  "../routes/admin-measure-cards.ts"
);

Deno.test("csvCell quotes and escapes", () => {
  assertEquals(csvCell('Apt "B"'), '"Apt ""B"""');
  assertEquals(csvCell(null), '""');
  assertEquals(csvCell(7), '"7"');
});

Deno.test("requestsToCsv emits the vendor columns in order", () => {
  const csv = requestsToCsv([
    {
      id: "r1",
      owner_user_id: "u1",
      status: "requested",
      card_version: 1,
      plan_key: "pro",
      ship_name: "Pat Doe",
      address_line1: "1 Main St",
      address_line2: null,
      city: "Austin",
      state: "TX",
      postal_code: "78701",
      country: "US",
      requested_at: "2026-07-03T00:00:00Z",
      exported_at: null,
      shipped_at: null,
    },
  ]);
  const [header, row] = csv.trim().split("\r\n");
  assertEquals(
    header,
    "request_id,ship_name,address_line1,address_line2,city,state,postal_code,country,card_version,plan,requested_at",
  );
  assert(row!.includes('"Pat Doe"') && row!.includes('"78701"'));
  // The owner's user id is NOT a CSV column — the vendor never sees it.
  assert(!row!.includes("u1"));
});

// ── Source contracts ────────────────────────────────────────────────

const sellerSrc = await Deno.readTextFile(
  new URL("../routes/flipdesk-measure.ts", import.meta.url),
);
const adminSrc = await Deno.readTextFile(
  new URL("../routes/admin-measure-cards.ts", import.meta.url),
);
const mainSrc = await Deno.readTextFile(
  new URL("../main.ts", import.meta.url),
);

Deno.test("US-268: seller card-request routes are owner-scoped", () => {
  // Every measure_card_requests touch in the seller route filters on the
  // workspace owner.
  const touches = sellerSrc.split('from("measure_card_requests")').length - 1;
  const scoped = sellerSrc.split('.eq("owner_user_id", ownerId)').length - 1;
  assert(touches >= 2, "expected the GET + active-check touches");
  assert(
    scoped >= touches - 1,
    `unscoped measure_card_requests access (touches=${touches}, scoped=${scoped})`,
  ); // the insert supplies owner_user_id in its payload instead of a filter
  assert(sellerSrc.includes("owner_user_id: ownerId"));
});

Deno.test("PII contract: the seller API never echoes the stored address", () => {
  // requestSummary is the only response shape; it carries no address fields.
  const start = sellerSrc.indexOf("function requestSummary");
  const end = sellerSrc.indexOf("}", sellerSrc.indexOf("return {", start));
  const body = sellerSrc.slice(start, end);
  for (const field of ["address_line1", "city", "postal_code", "ship_name"]) {
    assert(!body.includes(field), `requestSummary must not echo ${field}`);
  }
});

Deno.test("plan gate + one-active guard are server-side", () => {
  assert(sellerSrc.includes('if (plan === "free")'));
  assert(sellerSrc.includes("ACTIVE_REQUEST_STATUSES"));
  assert(sellerSrc.includes('insErr.code === "23505"'), "unique-index race handled");
});

Deno.test("operator queue mounts ONLY under the admin-auth stack", () => {
  assert(
    mainSrc.includes('app.route("/api/admin/measure-cards", adminMeasureCardRoutes)'),
  );
  // The global admin stack covers it.
  assert(mainSrc.includes('app.use("/api/admin/*", adminAuthMiddleware)'));
  // And the router file itself never mounts anywhere public.
  assert(!adminSrc.includes("/api/flipdesk/"));
});

Deno.test("shipped bulk-mark stamps the profile card-version record", () => {
  assert(adminSrc.includes('measure_card_source: "mail"'));
  assert(adminSrc.includes("measure_card_version: r.card_version"));
});
