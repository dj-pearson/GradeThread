// US-2126 AC4: drift guard between the canonical server catalog
// (lib/google-play/products.ts) and the Android offline fallback
// (SubscriptionCatalog.kt + CreditPacks.kt). The iOS half of this has existed
// since US-808 as iap-catalog-drift_test.ts; Android shipped Play Billing with
// no equivalent, so nothing compared the two sides at all.
//
// WHY THE EXISTING ANDROID TEST IS NOT THIS TEST. SubscriptionCatalogTest.kt
// asserts the six product ids against a HARDCODED list in the same repo, on the
// same side of the boundary. That catches a typo inside Kotlin and cannot catch
// the failure that matters: the server changing and Android not following. A
// drift guard has to read both sides, and only one of them can be the source of
// truth.
//
// WHAT DRIFT COSTS HERE, in the words of the Kotlin's own header: the server
// classifies a purchase from the reported product id alone and FAILS CLOSED on
// an unknown one. So a mismatched id is not a display bug — it is a subscription
// the buyer is charged for by Google and never entitled to on our side.

import { assertEquals } from "@std/assert";
import { ANDROID_CATALOG } from "../lib/google-play/products.ts";
import { CATALOG as APPSTORE_CATALOG } from "../lib/appstore/products.ts";
import { CREDIT_PACKS } from "../lib/grade-pricing.ts";

const SUBSCRIPTION_PATH = new URL(
  "../../../../android/app/src/main/java/com/gradethread/app/billing/SubscriptionCatalog.kt",
  import.meta.url,
);
const CREDIT_PACK_PATH = new URL(
  "../../../../android/app/src/main/java/com/gradethread/app/billing/CreditPacks.kt",
  import.meta.url,
);

interface KotlinSubscription {
  productId: string;
  plan: string;
  interval: string;
  fallbackPriceCents: number;
}

interface KotlinCreditPack {
  productId: string;
  credits: number;
  fallbackPriceCents: number;
}

/**
 * Slice an enum body out of Kotlin source by brace depth.
 *
 * Deliberately NOT "everything after the enum keyword": both files declare more
 * than one enum, and SubscriptionCatalog.kt declares PlanTier and
 * SubscriptionInterval above the one we want. Taking the rest of the file would
 * scoop up their entries and the companion object, and the resulting parse would
 * be wrong in a way that still produced plausible-looking rows.
 */
function enumBody(source: string, enumName: string): string {
  // Anchored on a non-identifier character after the name, not a bare indexOf.
  // A prefix match finds `SubscriptionProductX` when asked for
  // `SubscriptionProduct` and then parses the wrong enum's body — found while
  // sabotage-testing this file, where a rename mutation stayed green because of
  // exactly that.
  const header = source.search(
    new RegExp(`enum class ${enumName}(?![A-Za-z0-9_])`),
  );
  if (header === -1) throw new Error(`enum class ${enumName} not found`);
  const open = source.indexOf("{", header);
  if (open === -1) throw new Error(`no body for enum class ${enumName}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced body for enum class ${enumName}`);
}

function parseSubscriptions(source: string): KotlinSubscription[] {
  const body = enumBody(source, "SubscriptionProduct");
  const re =
    /\w+\(\s*"([^"]+)"\s*,\s*PlanTier\.(\w+)\s*,\s*SubscriptionInterval\.(\w+)\s*,\s*(\d+)\s*\)/g;
  const out: KotlinSubscription[] = [];
  for (const m of body.matchAll(re)) {
    out.push({
      productId: m[1],
      plan: m[2].toLowerCase(),
      interval: m[3].toLowerCase(),
      fallbackPriceCents: Number(m[4]),
    });
  }
  return out;
}

function parseCreditPacks(source: string): KotlinCreditPack[] {
  const body = enumBody(source, "CreditPack");
  const re = /\w+\(\s*"([^"]+)"\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g;
  const out: KotlinCreditPack[] = [];
  for (const m of body.matchAll(re)) {
    out.push({
      productId: m[1],
      credits: Number(m[2]),
      fallbackPriceCents: Number(m[3]),
    });
  }
  return out;
}

const subscriptions = parseSubscriptions(Deno.readTextFileSync(SUBSCRIPTION_PATH));
const creditPacks = parseCreditPacks(Deno.readTextFileSync(CREDIT_PACK_PATH));

Deno.test("the Kotlin catalogs actually parsed", () => {
  // The guard against a silently-empty guard. Every assertion below iterates a
  // parsed list, so a regex that stops matching after a formatting change would
  // turn this whole file green while comparing nothing — the failure mode that
  // makes a drift test worse than none.
  assertEquals(
    subscriptions.length > 0 && creditPacks.length > 0,
    true,
    `parsed ${subscriptions.length} subscription(s) and ${creditPacks.length} ` +
      `credit pack(s) out of the Kotlin sources; both must be non-empty`,
  );
});

Deno.test("Android fallback catalog has the same product ids as the server", () => {
  const kotlinIds = [...subscriptions, ...creditPacks]
    .map((e) => e.productId)
    .sort();
  const serverIds = Object.keys(ANDROID_CATALOG).sort();
  assertEquals(kotlinIds, serverIds);
});

Deno.test("Android subscription entries match the server plan/interval", () => {
  for (const sub of subscriptions) {
    const mapping = ANDROID_CATALOG[sub.productId];
    assertEquals(
      mapping !== undefined,
      true,
      `ANDROID_CATALOG has no ${sub.productId}; a purchase of it fails closed ` +
        `and the buyer is charged with nothing granted`,
    );
    if (!mapping) continue;
    assertEquals(
      mapping.kind,
      "subscription",
      `${sub.productId} is a subscription on Android and ${mapping.kind} on the server`,
    );
    if (mapping.kind !== "subscription") continue;
    assertEquals(
      { plan: sub.plan, interval: sub.interval },
      { plan: mapping.plan, interval: mapping.interval },
      `plan/interval drift for ${sub.productId}`,
    );
  }
});

Deno.test("Android credit packs match the server credit counts", () => {
  for (const pack of creditPacks) {
    const mapping = ANDROID_CATALOG[pack.productId];
    assertEquals(
      mapping !== undefined,
      true,
      `ANDROID_CATALOG has no ${pack.productId}`,
    );
    if (!mapping) continue;
    assertEquals(
      mapping.kind,
      "consumable",
      `${pack.productId} is a credit pack on Android and ${mapping.kind} on the server`,
    );
    if (mapping.kind !== "consumable") continue;
    assertEquals(
      pack.credits,
      mapping.credits,
      `credits drift for ${pack.productId}`,
    );
  }
});

// The prices are a fallback shown only until Play returns the real localized
// one, so they never decide a charge. They are guarded anyway because they are
// what the seller READS while deciding, and a stale number there is the same
// class of defect as US-2123 on iOS: the guard compared every machine-readable
// field and not the strings a purchase is actually made against.
//
// ANDROID_CATALOG carries no prices, so the comparison runs against the two
// places the Kotlin headers themselves name as the source: the App Store
// catalog's reference price for the same plan+interval, and CREDIT_PACKS.
Deno.test("Android fallback subscription prices match the reference price", () => {
  for (const sub of subscriptions) {
    const reference = APPSTORE_CATALOG.find(
      (e) =>
        e.mapping.kind === "subscription" &&
        e.mapping.plan === sub.plan &&
        e.mapping.interval === sub.interval,
    );
    assertEquals(
      reference !== undefined,
      true,
      `no App Store reference price for ${sub.plan}/${sub.interval}`,
    );
    if (!reference) continue;
    assertEquals(
      sub.fallbackPriceCents,
      reference.referencePriceCents,
      `fallback price drift for ${sub.productId} (Android ` +
        `${sub.fallbackPriceCents} vs reference ${reference.referencePriceCents})`,
    );
  }
});

Deno.test("Android fallback pack prices match CREDIT_PACKS", () => {
  for (const pack of creditPacks) {
    const canonical = CREDIT_PACKS.find((p) => p.credits === pack.credits);
    assertEquals(
      canonical !== undefined,
      true,
      `CREDIT_PACKS has no ${pack.credits}-credit pack`,
    );
    if (!canonical) continue;
    assertEquals(
      pack.fallbackPriceCents,
      canonical.priceCents,
      `fallback price drift for ${pack.productId}`,
    );
  }
});
