// US-3452: the delist log's pure builder. The DB-touching loader is covered by
// the tenant-isolation suite; here the story of one sale is pinned event by
// event, because the sentence "Poshmark ended 14:06 (your browser)" is the
// product and a wrong actor or a missing row is a wrong sentence.

import { assertEquals } from "@std/assert";
import {
  buildDelistLog,
  type DelistLogJobRow,
  type DelistLogListingRow,
} from "../lib/delist-log.ts";

function row(over: Partial<DelistLogListingRow> & { id: string; platform: string }): DelistLogListingRow {
  return {
    listing_status: "active",
    listing_url: null,
    delist_requested_at: null,
    platform_fields: null,
    sold_at: null,
    updated_at: "2026-09-21T14:00:00Z",
    ...over,
  };
}

function job(over: Partial<DelistLogJobRow> & { id: string; platform: string }): DelistLogJobRow {
  return {
    kind: "delist",
    listing_id: null,
    status: "queued",
    created_at: "2026-09-21T14:03:00Z",
    claimed_at: null,
    completed_at: null,
    result: null,
    ...over,
  };
}

Deno.test("a Poshmark sale: eBay ended by the server, Mercari by the browser, Grailed unresolved, Vinted still queued", () => {
  const rows = [
    row({ id: "p", platform: "poshmark", listing_status: "sold", sold_at: "2026-09-21T14:02:00Z" }),
    row({ id: "e", platform: "ebay", listing_status: "ended", updated_at: "2026-09-21T14:02:30Z" }),
    row({ id: "m", platform: "mercari", listing_status: "ended", listing_url: "https://www.mercari.com/us/item/m1/" }),
    row({
      id: "g",
      platform: "grailed",
      listing_status: "ended",
      delist_requested_at: "2026-09-21T14:02:31Z",
      listing_url: "https://www.grailed.com/listings/1",
    }),
    row({ id: "v", platform: "vinted", listing_status: "ended", delist_requested_at: "2026-09-21T14:02:31Z" }),
  ];
  const jobs = [
    job({ id: "j-m", platform: "mercari", listing_id: "m", status: "done", completed_at: "2026-09-21T14:07:00Z" }),
    job({
      id: "j-g",
      platform: "grailed",
      listing_id: "g",
      status: "failed",
      completed_at: "2026-09-21T14:06:00Z",
      result: { error: "Grailed confirms deletion in a native dialog nothing in a page can answer." },
    }),
    job({ id: "j-v", platform: "vinted", listing_id: "v", status: "queued", created_at: "2026-09-21T14:03:00Z" }),
  ];
  const events = buildDelistLog(rows, jobs);
  assertEquals(
    events.map((e) => [e.platform, e.event, e.actor, e.at]),
    [
      ["poshmark", "sold", "seller", "2026-09-21T14:02:00Z"],
      ["ebay", "ended_api", "server", "2026-09-21T14:02:30Z"],
      ["vinted", "queued", "browser", "2026-09-21T14:03:00Z"],
      ["grailed", "unresolved", "browser", "2026-09-21T14:06:00Z"],
      ["mercari", "ended_extension", "browser", "2026-09-21T14:07:00Z"],
    ],
  );
  // The still-live row keeps its link; the failed job's error rides as the note.
  assertEquals(events[3]!.url, "https://www.grailed.com/listings/1");
  assertEquals(
    events[3]!.note,
    "Grailed confirms deletion in a native dialog nothing in a page can answer.",
  );
});

Deno.test("a sale on eBay is the server's; an extension row ended with no job and no stamp was ended by hand", () => {
  const events = buildDelistLog(
    [
      row({ id: "e", platform: "ebay", listing_status: "sold", sold_at: "2026-09-21T10:00:00Z" }),
      row({ id: "p", platform: "poshmark", listing_status: "ended", updated_at: "2026-09-21T10:20:00Z" }),
    ],
    [],
  );
  assertEquals(events.map((e) => [e.platform, e.event, e.actor]), [
    ["ebay", "sold", "server"],
    ["poshmark", "ended_by_hand", "seller"],
  ]);
});

Deno.test("a stamped row with no job is waiting on the seller; an unstamped live row after a sale is waiting too", () => {
  const events = buildDelistLog(
    [
      row({ id: "e", platform: "ebay", listing_status: "sold", sold_at: "2026-09-21T10:00:00Z" }),
      row({ id: "p", platform: "poshmark", listing_status: "ended", delist_requested_at: "2026-09-21T10:00:05Z" }),
      row({ id: "m", platform: "mercari", listing_status: "active" }),
    ],
    [],
  );
  assertEquals(events.map((e) => [e.platform, e.event, e.at]), [
    ["ebay", "sold", "2026-09-21T10:00:00Z"],
    ["mercari", "waiting", "2026-09-21T10:00:00Z"],
    ["poshmark", "waiting", "2026-09-21T10:00:05Z"],
  ]);
  assertEquals(events[1]!.note, "Nothing has asked for this listing to end.");
});

Deno.test("the US-2165 marker on an unsupported channel reads as unresolved with its reason", () => {
  const events = buildDelistLog(
    [
      row({ id: "e", platform: "ebay", listing_status: "sold", sold_at: "2026-09-21T10:00:00Z" }),
      row({
        id: "w",
        platform: "whatnot",
        listing_status: "ended",
        platform_fields: {
          delist_unresolved: { detected_at: "2026-09-21T10:00:01Z", platform: "whatnot", reason: "no delist path" },
        },
      }),
    ],
    [],
  );
  assertEquals(events[1], {
    at: "2026-09-21T10:00:01Z",
    platform: "whatnot",
    listing_id: "w",
    event: "unresolved",
    actor: "server",
    url: null,
    note: "no delist path",
  });
});

Deno.test("a job with no listing id attaches to the row on its platform; a claimed job says a browser has it", () => {
  const events = buildDelistLog(
    [row({ id: "p", platform: "poshmark", listing_status: "ended", delist_requested_at: "2026-09-21T10:00:05Z" })],
    [job({ id: "j", platform: "poshmark", status: "claimed", claimed_at: "2026-09-21T10:04:00Z" })],
  );
  assertEquals(events.length, 1);
  assertEquals(events[0]!.event, "queued");
  assertEquals(events[0]!.note, "A browser has picked it up.");
});

Deno.test("drafts, list jobs and an unsold item produce nothing", () => {
  const events = buildDelistLog(
    [row({ id: "p", platform: "poshmark", listing_status: "draft" }), row({ id: "m", platform: "mercari" })],
    [job({ id: "j", platform: "poshmark", kind: "list" })],
  );
  assertEquals(events, []);
});
