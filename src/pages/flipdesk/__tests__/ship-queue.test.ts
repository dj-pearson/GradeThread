import { describe, expect, it } from "vitest";
import {
  rankShipQueue,
  shipCountdown,
  shipFallsBackToLocal,
  shipOneOrder,
} from "@/pages/flipdesk/ship-queue";

// A fixed clock so the bands are tested AT their edges, not near them.
const NOW = Date.parse("2026-09-08T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("shipCountdown", () => {
  it("names an overdue order in days once it is a day late", () => {
    const got = shipCountdown(new Date(NOW - 2 * DAY).toISOString(), NOW);
    expect(got.urgency).toBe("overdue");
    expect(got.label).toBe("Overdue by 2 days");
    expect(got.days).toBe(-2);
  });

  it("names an order less than a day late in hours, never as zero days", () => {
    // The failure this pins: flooring to days would render "Overdue by 0 days",
    // which reads as on time on the one row that most needs to read as late.
    const got = shipCountdown(new Date(NOW - 3 * HOUR).toISOString(), NOW);
    expect(got.urgency).toBe("overdue");
    expect(got.label).toBe("Overdue by 3 hours");
  });

  it("rounds a just-missed deadline up to one hour rather than zero", () => {
    const got = shipCountdown(new Date(NOW - 60_000).toISOString(), NOW);
    expect(got.label).toBe("Overdue by 1 hour");
  });

  it("counts down in hours inside the last day", () => {
    const got = shipCountdown(new Date(NOW + 5 * HOUR).toISOString(), NOW);
    expect(got.urgency).toBe("today");
    expect(got.label).toBe("Due in 5 hours");
    expect(got.days).toBe(0);
  });

  it("says within the hour rather than 'in 0 hours'", () => {
    const got = shipCountdown(new Date(NOW + 20 * 60_000).toISOString(), NOW);
    expect(got.urgency).toBe("today");
    expect(got.label).toBe("Due within the hour");
  });

  it("separates tomorrow from the day count", () => {
    const got = shipCountdown(new Date(NOW + DAY + HOUR).toISOString(), NOW);
    expect(got.urgency).toBe("tomorrow");
    expect(got.label).toBe("Due tomorrow");
    expect(got.days).toBe(1);
  });

  it("gives a plain day count further out", () => {
    const got = shipCountdown(new Date(NOW + 4 * DAY).toISOString(), NOW);
    expect(got.urgency).toBe("later");
    expect(got.label).toBe("4 days left");
    expect(got.days).toBe(4);
  });

  it("singularizes one day", () => {
    const got = shipCountdown(new Date(NOW + 2 * DAY + HOUR).toISOString(), NOW);
    expect(got.label).toBe("2 days left");
    const one = shipCountdown(new Date(NOW - DAY - HOUR).toISOString(), NOW);
    expect(one.label).toBe("Overdue by 1 day");
  });

  it("reads a missing deadline as none, never as overdue", () => {
    for (const value of [null, undefined, "", "   "]) {
      const got = shipCountdown(value, NOW);
      expect(got.urgency).toBe("none");
      expect(got.label).toBe("No deadline");
      expect(got.days).toBeNull();
    }
  });

  it("reads an unparseable deadline as none rather than counting to 1970", () => {
    const got = shipCountdown("whenever", NOW);
    expect(got.urgency).toBe("none");
    expect(got.days).toBeNull();
  });
});

describe("rankShipQueue", () => {
  it("puts the soonest deadline first and undated orders last", () => {
    const rows = [
      { id: "c", shipBy: null },
      { id: "a", shipBy: new Date(NOW + 3 * DAY).toISOString() },
      { id: "b", shipBy: new Date(NOW - DAY).toISOString() },
    ];
    expect(rankShipQueue(rows).map((r) => r.id)).toEqual(["b", "a", "c"]);
  });

  it("sorts an unparseable deadline with the undated, not with 1970", () => {
    const rows = [
      { id: "bad", shipBy: "not a date" },
      { id: "good", shipBy: new Date(NOW + DAY).toISOString() },
    ];
    expect(rankShipQueue(rows).map((r) => r.id)).toEqual(["good", "bad"]);
  });

  it("breaks ties on id so the order is stable across renders", () => {
    const same = new Date(NOW + DAY).toISOString();
    const rows = [
      { id: "z", shipBy: same },
      { id: "a", shipBy: same },
    ];
    expect(rankShipQueue(rows).map((r) => r.id)).toEqual(["a", "z"]);
  });

  it("does not mutate its input", () => {
    const rows = [
      { id: "b", shipBy: new Date(NOW + DAY).toISOString() },
      { id: "a", shipBy: new Date(NOW).toISOString() },
    ];
    const before = rows.map((r) => r.id);
    rankShipQueue(rows);
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});

// ── US-3190 AC4: the sale that is not eBay's to mark shipped ────────────────
//
// The queue is every completed unshipped sale, not every eBay one, and the card
// renders for a seller with no eBay connection at all (post-sale.tsx). Those
// two facts together mean the ship route CANNOT be the only write path: it
// answers 409 for a sale with no platform_order_id and 503 when the deployment
// has no eBay credentials, and on both the seller had typed a real tracking
// number for an order they had really shipped.

describe("shipFallsBackToLocal", () => {
  it("treats 409 (no eBay order id) as a local write, not a failure", () => {
    expect(shipFallsBackToLocal(409)).toBe(true);
  });

  it("treats 503 (eBay not configured here) as a local write", () => {
    expect(shipFallsBackToLocal(503)).toBe(true);
  });

  it("does NOT fall back on 502 — eBay rejected the tracking number", () => {
    // The one that must stay a failure. Writing shipped_at here would drop the
    // order out of the queue while the buyer still sees no tracking on eBay.
    expect(shipFallsBackToLocal(502)).toBe(false);
  });

  it("does not fall back on an unknown or missing status", () => {
    expect(shipFallsBackToLocal(undefined)).toBe(false);
    expect(shipFallsBackToLocal(null)).toBe(false);
    expect(shipFallsBackToLocal(500)).toBe(false);
    expect(shipFallsBackToLocal(401)).toBe(false);
  });
});

describe("shipOneOrder", () => {
  function spies() {
    const calls: string[] = [];
    return {
      calls,
      pushToEbay: async () => {
        calls.push("ebay");
      },
      writeLocal: async () => {
        calls.push("local");
      },
    };
  }

  it("pushes to eBay when the sale carries an order reference", async () => {
    const s = spies();
    await expect(shipOneOrder("12-34567-89012", s)).resolves.toBe("ebay");
    expect(s.calls).toEqual(["ebay"]);
  });

  it("writes locally without calling eBay when there is no order reference", async () => {
    const s = spies();
    await expect(shipOneOrder(null, s)).resolves.toBe("local");
    expect(s.calls).toEqual(["local"]);
  });

  it("treats a blank order reference as no reference", async () => {
    const s = spies();
    await expect(shipOneOrder("   ", s)).resolves.toBe("local");
    expect(s.calls).toEqual(["local"]);
  });

  it("falls back to the local write when the route answers 409", async () => {
    const calls: string[] = [];
    const got = await shipOneOrder("12-34567-89012", {
      pushToEbay: async () => {
        calls.push("ebay");
        throw Object.assign(new Error("no eBay order id"), { status: 409 });
      },
      writeLocal: async () => {
        calls.push("local");
      },
    });
    expect(got).toBe("local");
    expect(calls).toEqual(["ebay", "local"]);
  });

  it("rethrows a 502 and never writes shipped_at", async () => {
    const calls: string[] = [];
    await expect(
      shipOneOrder("12-34567-89012", {
        pushToEbay: async () => {
          calls.push("ebay");
          throw Object.assign(new Error("eBay rejected the tracking upload."), {
            status: 502,
          });
        },
        writeLocal: async () => {
          calls.push("local");
        },
      }),
    ).rejects.toThrow("eBay rejected the tracking upload.");
    expect(calls).toEqual(["ebay"]);
  });

  it("propagates a failure of the local write itself", async () => {
    await expect(
      shipOneOrder(null, {
        pushToEbay: async () => {},
        writeLocal: async () => {
          throw new Error("row level security");
        },
      }),
    ).rejects.toThrow("row level security");
  });
});
