// US-2943: once a day, and only when there is something to say.
//
// The sweep this rides in runs every 15 minutes. What makes it a DAILY digest
// is the claim key — `digest:YYYY-MM-DD` — so the first tick after midnight
// sends and the other ninety-five do nothing.
//
// The second rule matters more than it looks: an empty digest claims NOTHING.
// A digest that arrives every morning saying "0 items" is one people mute
// inside a week, and muting the offers category takes the real offer
// notifications down with it — so a seller whose first candidate appears at 4pm
// must still get the digest that day.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { sendOfferDigestForUser, utcDayStamp } = await import("../lib/offer-digest.ts");
import type { DigestDeps } from "../lib/offer-digest.ts";
import type { OfferCandidate } from "../lib/offer-candidates.ts";

const candidate = (watchers: number): OfferCandidate => ({
  listingId: `l${watchers}`,
  title: "Tee",
  priceCents: 5_000,
  watchers,
  daysListed: 20,
  lastOfferedAt: null,
});

function makeDeps(candidates: OfferCandidate[], over: Partial<DigestDeps> = {}) {
  const seen = new Set<string>();
  const sent: Array<{ count: number; watchers: number }> = [];
  let day = "2026-08-27";
  const deps: DigestDeps = {
    loadCandidates: () => Promise.resolve(candidates),
    claim: (ownerId, kind, externalId, status) => {
      const key = `${ownerId}|${kind}|${externalId}|${status}`;
      if (seen.has(key)) return Promise.resolve(false);
      seen.add(key);
      return Promise.resolve(true);
    },
    release: (ownerId, kind, externalId, status) => {
      seen.delete(`${ownerId}|${kind}|${externalId}|${status}`);
      return Promise.resolve();
    },
    notify: (ev) => {
      sent.push({ count: ev.count, watchers: ev.watchers });
      return Promise.resolve();
    },
    today: () => day,
    ...over,
  };
  return { deps, sent, seen, setDay: (d: string) => (day = d) };
}

Deno.test("the digest sends once and then not again the same day", async () => {
  const { deps, sent } = makeDeps([candidate(3), candidate(5)]);
  assertEquals(await sendOfferDigestForUser("u1", deps), 1);
  assertEquals(await sendOfferDigestForUser("u1", deps), 0);
  assertEquals(await sendOfferDigestForUser("u1", deps), 0);
  assertEquals(sent, [{ count: 2, watchers: 8 }]);
});

Deno.test("a new day sends again", async () => {
  const { deps, sent, setDay } = makeDeps([candidate(3)]);
  await sendOfferDigestForUser("u1", deps);
  setDay("2026-08-28");
  assertEquals(await sendOfferDigestForUser("u1", deps), 1);
  assertEquals(sent.length, 2);
});

Deno.test("an EMPTY day sends nothing and claims nothing", async () => {
  // The claim is what matters. If an empty run claimed the day, a seller whose
  // first candidate appears at 4pm would never hear about it.
  const empty = makeDeps([]);
  assertEquals(await sendOfferDigestForUser("u1", empty.deps), 0);
  assertEquals(empty.seen.size, 0, "nothing claimed");

  const later = makeDeps([candidate(2)], { claim: empty.deps.claim, notify: empty.deps.notify });
  assertEquals(await sendOfferDigestForUser("u1", later.deps), 1);
});

Deno.test("a failed send releases the claim so a later tick retries", async () => {
  let fail = true;
  const { deps, sent } = makeDeps([candidate(4)], {
    notify: (ev) => {
      if (fail) return Promise.reject(new Error("db down"));
      sent.push({ count: ev.count, watchers: ev.watchers });
      return Promise.resolve();
    },
  });
  assertEquals(await sendOfferDigestForUser("u1", deps), 0);
  fail = false;
  assertEquals(await sendOfferDigestForUser("u1", deps), 1);
});

Deno.test("a load failure is zero, not a thrown sweep", async () => {
  const { deps } = makeDeps([], {
    loadCandidates: () => Promise.reject(new Error("ebay down")),
  });
  assertEquals(await sendOfferDigestForUser("u1", deps), 0);
});

Deno.test("utcDayStamp is a calendar day, whatever the sweep's cadence", () => {
  assertEquals(utcDayStamp(Date.parse("2026-08-27T00:00:01.000Z")), "2026-08-27");
  assertEquals(utcDayStamp(Date.parse("2026-08-27T23:59:59.000Z")), "2026-08-27");
  assertEquals(utcDayStamp(Date.parse("2026-08-28T00:00:00.000Z")), "2026-08-28");
});
