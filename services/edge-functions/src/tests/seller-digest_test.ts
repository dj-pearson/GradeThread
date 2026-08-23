import { assertEquals } from "@std/assert";
import {
  composeSellerDigest,
  MIN_MONEY_LEFT_DOLLARS,
  type DigestInputs,
} from "../lib/seller-digest.ts";
import { detectSellerAnomaly } from "../lib/seller-anomaly.ts";

// US-2828 AC1/AC4. Every case is "does this seller get an email, and does it say
// the right thing first".

const EMPTY: DigestInputs = {
  scorecardGap: null,
  moneyLeft: null,
  bestVelocity: null,
  worstVelocity: null,
  anomalies: [],
};

const anomaly = () =>
  detectSellerAnomaly(
    "Items sold",
    [20, 22, 19, 21, 20, 18, 60].map((value, i) => ({
      week: `2026-01-${String(i + 1).padStart(2, "0")}`,
      value,
    })),
  )!;

Deno.test("AC4: nothing to report sends nothing", () => {
  assertEquals(composeSellerDigest(EMPTY), null);
});

Deno.test("AC4: CONTEXT ALONE IS NOT NEWS — the rule the no-op depends on", () => {
  // A scorecard always has a weakest metric; that is what a scorecard is. If its
  // presence counted as news, every digest would be non-empty and the no-op rule
  // would be deleted without anyone editing it.
  const contextOnly: DigestInputs = {
    ...EMPTY,
    scorecardGap: { metric: "Sell-through", percentile: 22 },
    bestVelocity: { label: "Nike", perDollarPerDay: 0.021 },
    worstVelocity: { label: "outerwear", perDollarPerDay: 0.003 },
  };
  assertEquals(
    composeSellerDigest(contextOnly),
    null,
    "a digest was sent containing only facts that are true every week",
  );
});

Deno.test("AC1: an anomaly alone is enough to send", () => {
  const d = composeSellerDigest({ ...EMPTY, anomalies: [anomaly()] });
  assertEquals(d !== null, true);
  assertEquals(d!.sections.length, 1);
  assertEquals(d!.sections[0]!.kind, "anomaly");
});

Deno.test("AC1: money left on the table alone is enough to send", () => {
  const d = composeSellerDigest({ ...EMPTY, moneyLeft: { dollars: 140, items: 6 } });
  assertEquals(d !== null, true);
  assertEquals(d!.sections[0]!.kind, "money_left");
  assertEquals(d!.sections[0]!.text.includes("$140"), true, d!.sections[0]!.text);
  assertEquals(d!.sections[0]!.text.includes("6 sold items"), true);
});

Deno.test("a trivial shortfall is true and is not worth an email", () => {
  const under = composeSellerDigest({
    ...EMPTY,
    moneyLeft: { dollars: MIN_MONEY_LEFT_DOLLARS - 0.01, items: 2 },
  });
  assertEquals(under, null, "a sub-floor shortfall sent an email on its own");

  const at = composeSellerDigest({
    ...EMPTY,
    moneyLeft: { dollars: MIN_MONEY_LEFT_DOLLARS, items: 2 },
  });
  assertEquals(at !== null, true, "the floor is exclusive when it should include its own value");
});

Deno.test("a sub-floor shortfall still RIDES ALONG when there is other news", () => {
  // It is not worth an email by itself; that does not make it worth hiding from
  // someone already reading one. ⚠ TODAY IT IS HIDDEN — the floor gates the
  // section, not just the send. Asserted as the CURRENT behaviour so a future
  // change to carry it is a deliberate edit against a failing test rather than a
  // silent one.
  const d = composeSellerDigest({
    ...EMPTY,
    anomalies: [anomaly()],
    moneyLeft: { dollars: 3, items: 1 },
  });
  assertEquals(d !== null, true);
  assertEquals(
    d!.sections.some((s) => s.kind === "money_left"),
    false,
    "if this now passes, the floor was changed to gate only the SEND — update " +
      "this case to assert the section is present",
  );
});

Deno.test("AC1: context rides along once there is news", () => {
  const d = composeSellerDigest({
    scorecardGap: { metric: "Sell-through", percentile: 22 },
    moneyLeft: { dollars: 140, items: 6 },
    bestVelocity: { label: "Nike", perDollarPerDay: 0.021 },
    worstVelocity: { label: "outerwear", perDollarPerDay: 0.003 },
    anomalies: [anomaly()],
  });
  assertEquals(d !== null, true);
  assertEquals(
    d!.sections.map((s) => s.kind),
    ["anomaly", "money_left", "scorecard", "velocity"],
    "the reading order changed: what happened, what it cost, where you stand, " +
      "what is working",
  );
});

Deno.test("AC1: all four sources are represented", () => {
  // The criterion names four things. A section quietly dropped would leave the
  // digest looking complete.
  const d = composeSellerDigest({
    scorecardGap: { metric: "Return rate", percentile: 12 },
    moneyLeft: { dollars: 80, items: 3 },
    bestVelocity: { label: "denim", perDollarPerDay: 0.03 },
    worstVelocity: { label: "coats", perDollarPerDay: 0.001 },
    anomalies: [anomaly()],
  })!;
  const kinds = new Set(d.sections.map((s) => s.kind));
  for (const k of ["anomaly", "money_left", "scorecard", "velocity"]) {
    assertEquals(kinds.has(k as never), true, `missing section: ${k}`);
  }
});

Deno.test("the headline is the first section, so a one-line reader gets the best one", () => {
  const d = composeSellerDigest({
    ...EMPTY,
    anomalies: [anomaly()],
    moneyLeft: { dollars: 140, items: 6 },
  })!;
  assertEquals(d.headline, d.sections[0]!.text);
  assertEquals(d.sections[0]!.kind, "anomaly", "money outranked an anomaly in the headline");
});

Deno.test("both velocity ends or neither", () => {
  // A 'best' alone reads as praise and a 'worst' alone as a telling-off. The
  // pair is a comparison, which is the only thing it is for.
  const bestOnly = composeSellerDigest({
    ...EMPTY,
    anomalies: [anomaly()],
    bestVelocity: { label: "Nike", perDollarPerDay: 0.021 },
  })!;
  assertEquals(bestOnly.sections.some((s) => s.kind === "velocity"), false);

  const worstOnly = composeSellerDigest({
    ...EMPTY,
    anomalies: [anomaly()],
    worstVelocity: { label: "coats", perDollarPerDay: 0.001 },
  })!;
  assertEquals(worstOnly.sections.some((s) => s.kind === "velocity"), false);
});

Deno.test("every anomaly is carried, not just the first", () => {
  const a = anomaly();
  const d = composeSellerDigest({ ...EMPTY, anomalies: [a, a, a] })!;
  assertEquals(d.sections.filter((s) => s.kind === "anomaly").length, 3);
});

Deno.test("money reads as dollars-and-cents when small and whole when large", () => {
  const small = composeSellerDigest({ ...EMPTY, moneyLeft: { dollars: 42.5, items: 2 } })!;
  assertEquals(small.headline.includes("$42.50"), true, small.headline);
  const large = composeSellerDigest({ ...EMPTY, moneyLeft: { dollars: 1240.4, items: 30 } })!;
  assertEquals(large.headline.includes("$1240"), true, large.headline);
  assertEquals(large.headline.includes(".40"), false, "cents on a four-figure number");
});

Deno.test("one item is not 'items'", () => {
  const d = composeSellerDigest({ ...EMPTY, moneyLeft: { dollars: 60, items: 1 } })!;
  assertEquals(d.headline.includes("1 sold item this week"), true, d.headline);
  // And the plural really does differ, or the singular case proves nothing.
  const many = composeSellerDigest({ ...EMPTY, moneyLeft: { dollars: 60, items: 2 } })!;
  assertEquals(many.headline.includes("2 sold items this week"), true, many.headline);
});

Deno.test("no section carries jargon or a verdict", () => {
  // Same rule as describeAnomaly, applied to every line the seller reads.
  const d = composeSellerDigest({
    scorecardGap: { metric: "Sell-through", percentile: 22 },
    moneyLeft: { dollars: 140, items: 6 },
    bestVelocity: { label: "Nike", perDollarPerDay: 0.021 },
    worstVelocity: { label: "outerwear", perDollarPerDay: 0.003 },
    anomalies: [anomaly()],
  })!;
  for (const s of d.sections) {
    for (const word of ["sigma", "deviation", "z-score", "variance"]) {
      assertEquals(s.text.toLowerCase().includes(word), false, `jargon in ${s.kind}: ${s.text}`);
    }
    for (const word of ["good", "bad", "great", "worse", "problem", "congrat", "should"]) {
      assertEquals(s.text.toLowerCase().includes(word), false, `verdict in ${s.kind}: ${s.text}`);
    }
  }
});
