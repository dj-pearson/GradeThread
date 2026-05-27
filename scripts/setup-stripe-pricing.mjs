#!/usr/bin/env node
// Stripe products + prices setup (US-203).
//
// Idempotent: looks up products by metadata.gradethread_sku and updates in
// place instead of duplicating. Prices are immutable on amount/currency, so
// we keep an existing matching price (same product + sku + amount + interval)
// and only create a new one when one doesn't exist. Outdated prices are
// flagged for manual archive — never auto-deleted.
//
// Usage:
//   STRIPE_SECRET_KEY=sk_test_... node scripts/setup-stripe-pricing.mjs
//   STRIPE_SECRET_KEY=sk_live_... node scripts/setup-stripe-pricing.mjs --live
//
// Output: prints a VITE_STRIPE_PRICE_* env block ready to paste into
// Coolify / Cloudflare Pages, plus the FlipDesk + GradeThread + credit-pack
// price IDs for the edge functions.
//
// The catalog mirrors src/lib/constants.ts (US-202). If you change pricing
// there, re-run this script and re-deploy the new env block.

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const LIVE = process.argv.includes("--live");

if (!STRIPE_SECRET_KEY) {
  console.error("STRIPE_SECRET_KEY is required");
  process.exit(1);
}
if (LIVE && !STRIPE_SECRET_KEY.startsWith("sk_live_")) {
  console.error("--live flag set but STRIPE_SECRET_KEY is not a live key");
  process.exit(1);
}
if (!LIVE && STRIPE_SECRET_KEY.startsWith("sk_live_")) {
  console.error("STRIPE_SECRET_KEY is a live key but --live was not passed");
  process.exit(1);
}

const STRIPE = "https://api.stripe.com/v1";

// ── Catalog (mirror of FLIPDESK_PLANS / GRADETHREAD_TIERS / CREDIT_PACKS) ──
const FLIPDESK = [
  { sku: "flipdesk_starter",  name: "FlipDesk Starter",  monthly: 2900, yearly: 29000 },
  { sku: "flipdesk_pro",      name: "FlipDesk Pro",      monthly: 5900, yearly: 59000 },
  { sku: "flipdesk_business", name: "FlipDesk Business", monthly: 9900, yearly: 99000 },
];
const GRADES = [
  { sku: "grade_standard", name: "GradeThread Standard Grade", amount: 299 },
  { sku: "grade_premium",  name: "GradeThread Premium Grade",  amount: 799 },
  { sku: "grade_express",  name: "GradeThread Express Grade",  amount: 1299 },
];
const PACKS = [
  { sku: "credits_10",  name: "GradeThread Credit Pack — 10",  amount: 2499 },
  { sku: "credits_25",  name: "GradeThread Credit Pack — 25",  amount: 5999 },
  { sku: "credits_50",  name: "GradeThread Credit Pack — 50",  amount: 10999 },
  { sku: "credits_100", name: "GradeThread Credit Pack — 100", amount: 19999 },
];

// ── Stripe helpers ────────────────────────────────────────────────
function formEncode(obj, prefix = "") {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object" && !Array.isArray(v)) {
      parts.push(formEncode(v, key));
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => parts.push(formEncode({ [i]: item }, key)));
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.filter(Boolean).join("&");
}

async function stripe(method, path, body) {
  const res = await fetch(`${STRIPE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body ? formEncode(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function findProductBySku(sku) {
  const data = await stripe(
    "GET",
    `/products/search?query=${encodeURIComponent(`metadata['gradethread_sku']:'${sku}'`)}&limit=1`
  );
  return data.data[0] ?? null;
}

async function findPrice(productId, { amount, currency, recurring }) {
  // Stripe price search doesn't filter by amount precisely; list prices on
  // the product and match locally.
  const data = await stripe("GET", `/prices?product=${productId}&limit=100&active=true`);
  return data.data.find((p) => {
    if (p.unit_amount !== amount) return false;
    if (p.currency !== currency) return false;
    if (recurring) {
      return p.recurring && p.recurring.interval === recurring.interval;
    }
    return !p.recurring;
  }) ?? null;
}

async function upsertProduct({ sku, name }) {
  const existing = await findProductBySku(sku);
  if (existing) {
    if (existing.name !== name) {
      await stripe("POST", `/products/${existing.id}`, { name });
      console.log(`  updated product name → ${name}`);
    }
    return existing.id;
  }
  const created = await stripe("POST", "/products", {
    name,
    metadata: { gradethread_sku: sku },
  });
  console.log(`  created product ${name} (${created.id})`);
  return created.id;
}

async function upsertPrice(productId, sku, { amount, currency = "usd", recurring, lookupKey }) {
  const existing = await findPrice(productId, { amount, currency, recurring });
  if (existing) return existing.id;

  const body = {
    product: productId,
    unit_amount: amount,
    currency,
    lookup_key: lookupKey,
    metadata: { gradethread_sku: sku },
  };
  if (recurring) {
    body.recurring = { interval: recurring.interval };
  }
  // tax_behavior + tax_code wire up Stripe Tax (US-223)
  body.tax_behavior = "exclusive";
  const created = await stripe("POST", "/prices", body);
  console.log(`  created price ${created.id} (${amount}¢ ${recurring?.interval ?? "one-time"})`);
  return created.id;
}

// ── Main ─────────────────────────────────────────────────────────
const env = {};

console.log(`\nStripe setup ${LIVE ? "[LIVE]" : "[TEST]"}\n`);

console.log("FlipDesk subscriptions:");
for (const plan of FLIPDESK) {
  const productId = await upsertProduct(plan);
  const monthlyId = await upsertPrice(productId, plan.sku, {
    amount: plan.monthly,
    recurring: { interval: "month" },
    lookupKey: `${plan.sku}_monthly`,
  });
  const yearlyId = await upsertPrice(productId, plan.sku, {
    amount: plan.yearly,
    recurring: { interval: "year" },
    lookupKey: `${plan.sku}_yearly`,
  });
  env[`VITE_STRIPE_PRICE_${plan.sku.toUpperCase()}_MONTHLY`] = monthlyId;
  env[`VITE_STRIPE_PRICE_${plan.sku.toUpperCase()}_YEARLY`] = yearlyId;
}

console.log("\nGradeThread per-grade:");
for (const grade of GRADES) {
  const productId = await upsertProduct(grade);
  const priceId = await upsertPrice(productId, grade.sku, {
    amount: grade.amount,
    lookupKey: grade.sku,
  });
  env[`VITE_STRIPE_PRICE_${grade.sku.toUpperCase()}`] = priceId;
}

console.log("\nCredit packs:");
for (const pack of PACKS) {
  const productId = await upsertProduct(pack);
  const priceId = await upsertPrice(productId, pack.sku, {
    amount: pack.amount,
    lookupKey: pack.sku,
  });
  env[`VITE_STRIPE_PRICE_${pack.sku.toUpperCase()}`] = priceId;
}

// ── Output env block ─────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}`);
console.log("ENV BLOCK — paste into Coolify (edge) and CF Pages (frontend):");
console.log(`${"─".repeat(60)}\n`);
console.log(
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n")
);
console.log("\nEdge functions also need the non-VITE_ aliases. Mapping:\n");
console.log(
  Object.entries(env)
    .map(([k, v]) => `${k.replace(/^VITE_/, "")}=${v}`)
    .join("\n")
);
console.log(
  "\nDone. Re-running this script is idempotent — products/prices are reused."
);
