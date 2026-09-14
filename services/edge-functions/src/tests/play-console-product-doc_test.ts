// US-2913: pin the OPERATOR-FACING product tables to ANDROID_CATALOG.
//
// There are three copies of the Play product list and only two of them are code.
// android-catalog-drift_test.ts already holds the server catalog
// (lib/google-play/products.ts) and the Android fallback (SubscriptionCatalog.kt +
// CreditPacks.kt) together. The third copy is Play Console itself, which no test
// can reach, and the only thing standing between a developer and that Console is
// the table an operator types from. PLAY_STORE_SUBMISSION.md says so in its own
// words: "Play Console is the third copy and nothing pins that one but this list."
//
// That list was wrong. US-3138 added four Action Credit packs to ANDROID_CATALOG
// and to CreditPacks.kt, both code sides agreed, the drift guard stayed green, and
// both operator documents went on saying ten products for the rest of the epic.
//
// WHY THAT IS EXPENSIVE RATHER THAN UNTIDY. BillingRepository asks Play for
// ActionCreditPack.productIds, and Play's contract for an id it does not have is
// not an error: PlayBilling's own comment says "Missing ids are simply absent."
// So an operator who created the ten products the docs listed would ship a signed,
// under-budget, fully green release whose Action Credits top-up sheet is empty,
// with no crash, no log line and nothing for a reviewer or a seller to report
// beyond "the button does nothing".
//
// The helpers below are PURE functions over markdown TEXT and are exported on
// purpose: a sabotage case is then a string literal in this file rather than an
// edit to a document that has to be undone.

// US-2379: first, before anything that reaches lib/supabase.ts at import time.
import "./_env.ts";

import { assertEquals } from "@std/assert";
import {
  ANDROID_ACTION_CREDIT_PRODUCT_IDS,
  ANDROID_CATALOG,
  ANDROID_CONSUMABLE_PRODUCT_IDS,
  ANDROID_SUBSCRIPTION_PRODUCT_IDS,
  BUYER_ANDROID_CATALOG,
} from "../lib/google-play/products.ts";
import { ACTION_CREDIT_PACKS } from "../lib/action-credits.ts";
import { CREDIT_PACKS } from "../lib/grade-pricing.ts";

const DOCS = {
  "android/PLAY_STORE_SUBMISSION.md": new URL(
    "../../../../android/PLAY_STORE_SUBMISSION.md",
    import.meta.url,
  ),
  "android/PLAY_SETUP_RUNBOOK.md": new URL(
    "../../../../android/PLAY_SETUP_RUNBOOK.md",
    import.meta.url,
  ),
} as const;

/** Read a doc with line endings normalized. Git checks this tree out with CRLF on
 *  Windows, and a needle carrying `\n` silently never matches there. */
function readDoc(url: URL): string {
  return Deno.readTextFileSync(url).replace(/\r\n/g, "\n");
}

/**
 * Every markdown table row whose first cell is a lowercase snake_case identifier
 * in backticks, mapped to the price in its LAST cell (in cents), or null when the
 * last cell is not a price.
 *
 * The shape filter is what keeps this off the other tables in these documents.
 * Environment-variable tables key on SCREAMING_CASE and the fact tables key on
 * prose, so neither is picked up; measured against both files, this returns the
 * product rows and nothing else.
 */
export function productTableRows(markdown: string): Map<string, number | null> {
  const rows = new Map<string, number | null>();
  for (const line of markdown.split("\n")) {
    const m = /^\|\s*`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`\s*\|(.*)$/.exec(line);
    if (!m) continue;
    const cells = m[2].split("|").map((c) => c.trim()).filter((c) => c !== "");
    const last = cells[cells.length - 1] ?? "";
    const price = /^\$?([0-9,]+(?:\.[0-9]{2})?)$/.exec(last);
    rows.set(
      m[1],
      price ? Math.round(Number(price[1].replace(/,/g, "")) * 100) : null,
    );
  }
  return rows;
}

/** Every "<n> in-app products" claim in the prose, as numbers. A generated table
 *  can be perfectly in sync while the sentence counting it is stale. */
export function productCountClaims(markdown: string): number[] {
  return [...markdown.matchAll(/(\d+)\s+in-app products/g)].map((m) => Number(m[1]));
}

/** The USD price, in cents, an operator must type into Play Console for each id. */
function expectedPriceCents(): Map<string, number> {
  const out = new Map<string, number>();

  // Subscriptions: the Kotlin fallback is the pinned source (android-catalog-drift
  // already holds it equal to the web plan constants), and it is what the paywall
  // shows until Play answers with the localized price.
  const kotlin = Deno.readTextFileSync(
    new URL(
      "../../../../android/app/src/main/java/com/gradethread/app/billing/SubscriptionCatalog.kt",
      import.meta.url,
    ),
  ).replace(/\r\n/g, "\n");
  for (
    const m of kotlin.matchAll(
      /\w+\(\s*"([^"]+)"\s*,\s*PlanTier\.\w+\s*,\s*SubscriptionInterval\.\w+\s*,\s*(\d+)\s*\)/g,
    )
  ) {
    out.set(m[1], Number(m[2]));
  }

  for (const pack of CREDIT_PACKS) out.set(`credits_${pack.credits}`, pack.priceCents);
  for (const pack of Object.values(ACTION_CREDIT_PACKS)) {
    out.set(pack.playProductId, pack.priceCents);
  }
  return out;
}

Deno.test("operator docs list EVERY ANDROID_CATALOG product as a table row", () => {
  const expected = Object.keys(ANDROID_CATALOG).sort();
  for (const [name, url] of Object.entries(DOCS)) {
    const found = [...productTableRows(readDoc(url)).keys()].sort();
    assertEquals(
      found,
      expected,
      `${name} product tables disagree with ANDROID_CATALOG. An id missing here is ` +
        `a product the operator never creates, and Play omits an unknown id from ` +
        `the catalog response instead of failing, so the app just shows nothing.`,
    );
  }
});

Deno.test("operator docs quote the Play Console price from the code", () => {
  const expected = expectedPriceCents();
  for (const [name, url] of Object.entries(DOCS)) {
    for (const [id, cents] of productTableRows(readDoc(url))) {
      assertEquals(
        cents,
        expected.get(id) ?? null,
        `${name}: the price for ${id} is not the one the app falls back to. ` +
          `The Console price is a real charge; the app's is a label.`,
      );
    }
  }
});

Deno.test("every 'N in-app products' claim counts the real catalog", () => {
  const total = Object.keys(ANDROID_CATALOG).length;
  for (const [name, url] of Object.entries(DOCS)) {
    const claims = productCountClaims(readDoc(url));
    assertEquals(
      claims.length > 0,
      true,
      `${name} states no product count at all; §0 and the fact table both need one.`,
    );
    assertEquals(
      claims.filter((n) => n !== total),
      [],
      `${name} claims a product count that is not ${total}.`,
    );
  }
});

Deno.test("the three groups add up to the total the docs claim", () => {
  assertEquals(
    ANDROID_SUBSCRIPTION_PRODUCT_IDS.length +
      ANDROID_CONSUMABLE_PRODUCT_IDS.length +
      ANDROID_ACTION_CREDIT_PRODUCT_IDS.length,
    Object.keys(ANDROID_CATALOG).length,
    "ANDROID_CATALOG grew a kind the operator docs have no section for. Add the " +
      "section and the table before this catalog ships a product nobody creates.",
  );
});

Deno.test("the unwired buyer products stay OUT of the operator docs", () => {
  // BUYER_ANDROID_CATALOG exists but classifyAndroidProduct returns null for every
  // id in it, and no Android surface queries them. Creating them in the Console
  // would put four subscriptions on sale that the server refuses to entitle, which
  // is the exact failure the rest of this file guards against, inverted.
  for (const [name, url] of Object.entries(DOCS)) {
    const rows = productTableRows(readDoc(url));
    for (const id of Object.keys(BUYER_ANDROID_CATALOG)) {
      assertEquals(
        rows.has(id),
        false,
        `${name} tells the operator to create ${id}, which the server does not ` +
          `entitle. Wire it into classifyAndroidProduct first.`,
      );
    }
  }
});

Deno.test("productTableRows reads product rows and skips the other tables", () => {
  // The sabotage cases, as literals: this is the shape the documents had before
  // US-2913, and the shapes that must not be mistaken for products.
  const before = [
    "| Product ID | Credits | Base price (USD) |",
    "|---|---|---|",
    "| `credits_10` | 10 | $24.99 |",
    "| `credits_25` | 25 | $59.99 |",
    "",
    "| Var | Value |",
    "|---|---|",
    "| `GOOGLE_PLAY_PACKAGE_NAME` | com.gradethread.myapp |",
    "| Store title | GradeThread |",
  ].join("\n");
  assertEquals([...productTableRows(before).keys()], ["credits_10", "credits_25"]);
  assertEquals(productTableRows(before).get("credits_10"), 2499);

  // A row with no price cell is still a row; it just has nothing to compare.
  assertEquals(
    productTableRows("| `action_credits_50` | 50 | see Console |").get("action_credits_50"),
    null,
  );

  assertEquals(productCountClaims("there are 14 in-app products"), [14]);
  assertEquals(productCountClaims("10 in-app products, then 14 in-app products"), [10, 14]);
});
