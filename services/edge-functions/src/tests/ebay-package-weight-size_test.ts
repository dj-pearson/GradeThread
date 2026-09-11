// US-2790 consumer 3: packageWeightAndSize on the eBay inventory_item PUT.
//
// WHAT THESE CASES ARE PROTECTING. A wrong field name, a wrong unit enum or a
// half-built container here does not fail at compile - it fails at PUBLISH, by
// which point the offer already exists on a live seller's account and every
// retry answers "offer already exists". So the shape is pinned here, the flag
// that keeps it inert is pinned here, and the payload with the flag OFF is held
// byte-identical to the one that shipped before the field existed.
//
// THE 16x CASE IS THE POINT OF THE FIRST GROUP. eBay accepts POUND and OUNCE,
// estimateParcel returns ounces, and a pound number carrying an OUNCE unit
// publishes successfully and is wrong by a factor of sixteen. Every assertion
// below that touches weight asserts `value` and `unit` TOGETHER for that
// reason - checking either one alone would pass on the mismatch.

import { assert, assertEquals } from "@std/assert";

// ebay-client.ts constructs the service-role supabase client at import time,
// which throws without these. Set before the dynamic import, mirroring
// ebay-aspect-cap_test.ts.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  buildPackageWeightAndSize,
  packageDimensionsFrom,
  packageWeightAndSizeForPublish,
  packageWeightAndSizeEnabled,
  EBAY_PACKAGE_WEIGHT_AND_SIZE_FLAG,
} = await import("../lib/ebay-client.ts");

const { estimateParcel, PACK_DIMENSIONS } = await import("../lib/parcel-estimate.ts");

/** Run `fn` with the flag set to `value`, restoring whatever was there. */
function withFlag<T>(value: string | null, fn: () => T): T {
  const previous = Deno.env.get(EBAY_PACKAGE_WEIGHT_AND_SIZE_FLAG) ?? null;
  if (value === null) Deno.env.delete(EBAY_PACKAGE_WEIGHT_AND_SIZE_FLAG);
  else Deno.env.set(EBAY_PACKAGE_WEIGHT_AND_SIZE_FLAG, value);
  try {
    return fn();
  } finally {
    if (previous === null) Deno.env.delete(EBAY_PACKAGE_WEIGHT_AND_SIZE_FLAG);
    else Deno.env.set(EBAY_PACKAGE_WEIGHT_AND_SIZE_FLAG, previous);
  }
}

// --- The shape, from a real garment ----------------------------------------

Deno.test("a wool coat, chest 26in: the worked example, value and unit together", () => {
  const parcel = estimateParcel({
    garmentCategory: "coat",
    material: "100% wool",
    measurements: { chest: 26 },
    size: "L",
  });
  // 48 oz base * (26/21) size factor * 1.25 wool + 0.9 oz mailer_large.
  assertEquals(Math.round(parcel.weightOz * 1000) / 1000, 75.186);
  assertEquals(parcel.pack, "mailer_large");

  const out = buildPackageWeightAndSize(parcel)!;
  // The pair, asserted as a pair. 75.2 POUND would be a 16x error that eBay
  // would accept without complaint.
  assertEquals(out.weight, { value: 75.2, unit: "OUNCE" });
  assertEquals(out.dimensions, {
    height: 3,
    length: 14,
    width: 19,
    unit: "INCH",
  });
});

Deno.test("the dimensions are the estimator's own pack table, not a second copy", () => {
  // A second hard-coded copy of the pack sizes would let eBay be told one
  // parcel while the margin floor bills another.
  for (const pack of Object.keys(PACK_DIMENSIONS) as Array<keyof typeof PACK_DIMENSIONS>) {
    const dims = PACK_DIMENSIONS[pack];
    const out = buildPackageWeightAndSize({ weightOz: 10, pack })!;
    assertEquals(out.dimensions, {
      height: dims.heightIn,
      length: dims.lengthIn,
      width: dims.widthIn,
      unit: "INCH",
    });
  }
});

Deno.test("the wire names are camelCase and nothing unsourced is sent", () => {
  const out = buildPackageWeightAndSize({ weightOz: 12.34, pack: "box_small" })!;
  assertEquals(
    JSON.stringify(out),
    '{"weight":{"value":12.3,"unit":"OUNCE"},' +
      '"dimensions":{"height":4,"length":12,"width":9,"unit":"INCH"}}',
  );
  // packageType's MEMBER names are not sourced and shippingIrregular is a fact
  // about the parcel nothing in the record knows. Neither is guessed at.
  assert(!("packageType" in out), "packageType must not be sent unsourced");
  assert(!("shippingIrregular" in out), "shippingIrregular must not be guessed");
});

// --- A partial container must be impossible to construct -------------------

Deno.test("a missing weight omits the whole weight key, never a half container", () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const out = buildPackageWeightAndSize({ weightOz: bad, pack: "box_small" })!;
    assert(
      !("weight" in out),
      `weightOz ${bad} produced a weight container: ${JSON.stringify(out)}`,
    );
    // The dimensions it CAN describe still go, whole.
    assertEquals(out.dimensions, { height: 4, length: 12, width: 9, unit: "INCH" });
  }
});

Deno.test("one unusable side drops all three, never a partial dimension set", () => {
  // THE REASON THIS TAKES RAW SIDES RATHER THAN A PACK. Every entry in
  // PACK_DIMENSIONS has three positive sides, so with the rule buried inside
  // buildPackageWeightAndSize a sabotage that deleted the width check passed
  // 11/11 - the branch could not be reached from any pack that exists. These
  // cases reach it.
  assertEquals(
    packageDimensionsFrom({ lengthIn: 12, widthIn: 9, heightIn: 4 }),
    { height: 4, length: 12, width: 9, unit: "INCH" },
  );
  for (const bad of [
    { lengthIn: 12, widthIn: 0, heightIn: 4 },
    { lengthIn: 12, widthIn: 9, heightIn: Number.NaN },
    { lengthIn: -12, widthIn: 9, heightIn: 4 },
    { lengthIn: Number.POSITIVE_INFINITY, widthIn: 9, heightIn: 4 },
  ]) {
    assertEquals(
      packageDimensionsFrom(bad),
      undefined,
      `${JSON.stringify(bad)} produced a dimension container`,
    );
  }
  assertEquals(packageDimensionsFrom(undefined), undefined);
  assertEquals(packageDimensionsFrom(null), undefined);
});

Deno.test("an unknown pack omits the whole dimensions key", () => {
  const out = buildPackageWeightAndSize(
    { weightOz: 9, pack: "no_such_pack" as unknown as keyof typeof PACK_DIMENSIONS },
  )!;
  assert(!("dimensions" in out), `unknown pack produced dimensions: ${JSON.stringify(out)}`);
  assertEquals(out.weight, { value: 9, unit: "OUNCE" });
});

Deno.test("nothing buildable returns undefined, not an empty object", () => {
  // `packageWeightAndSize: {}` is a container eBay has to interpret; absence is
  // not. The two are different on the wire and only one is safe.
  assertEquals(buildPackageWeightAndSize(null), undefined);
  assertEquals(buildPackageWeightAndSize(undefined), undefined);
  assertEquals(
    buildPackageWeightAndSize(
      { weightOz: 0, pack: "no_such_pack" as unknown as keyof typeof PACK_DIMENSIONS },
    ),
    undefined,
  );
});

// --- The flag, and what OFF actually means on the wire ---------------------

Deno.test("the flag is OFF unless it is exactly the string true", () => {
  const parcel = { weightOz: 20, pack: "mailer_large" as const };
  for (const value of [null, "", "false", "False", "0", "1", "yes", "on", "TRUE", " true"]) {
    assertEquals(
      withFlag(value, () => packageWeightAndSizeEnabled()),
      false,
      `flag value ${JSON.stringify(value)} must not enable the field`,
    );
    assertEquals(
      withFlag(value, () => packageWeightAndSizeForPublish(parcel)),
      undefined,
      `flag value ${JSON.stringify(value)} must not send the field`,
    );
  }
  assertEquals(withFlag("true", () => packageWeightAndSizeEnabled()), true);
  assert(withFlag("true", () => packageWeightAndSizeForPublish(parcel)) !== undefined);
});

Deno.test("the flag constant and the literal that is actually read cannot drift", () => {
  // packageWeightAndSizeEnabled reads a STRING LITERAL rather than the constant
  // so scripts/check-env-reference.mjs can see the name and require a row in
  // vault/10-ops/env-reference.md - it matches a quoted name and is blind to a
  // variable. That buys a real guard and costs a place for the two to disagree,
  // which is what this closes: rename one and the other stops matching here.
  const src = Deno.readTextFileSync(new URL("../lib/ebay-client.ts", import.meta.url));
  const literals = [
    ...src.matchAll(/Deno\.env\.get\(\s*"(EBAY_PACKAGE_WEIGHT_AND_SIZE[A-Z0-9_]*)"/g),
  ].map((m) => m[1]!);
  assertEquals(literals, [EBAY_PACKAGE_WEIGHT_AND_SIZE_FLAG]);
});

Deno.test("flag OFF: the publish body is byte-identical to the one before this existed", () => {
  // The payload the publish path built before US-2790 touched it.
  const before = {
    product: {
      title: "Patagonia Better Sweater",
      description: "<p>Nice</p>",
      aspects: { Brand: ["Patagonia"] },
      imageUrls: ["https://example.test/a.jpg"],
      brand: "Patagonia",
      mpn: "Does Not Apply",
      epid: undefined,
    },
    condition: "USED_EXCELLENT",
    conditionDescription: undefined,
    availability: { shipToLocationAvailability: { quantity: 1 } },
  };
  const parcel = estimateParcel({
    garmentCategory: "sweater",
    material: "fleece",
    measurements: { chest: 22 },
    size: "M",
  });

  const withField = withFlag(null, () => ({
    ...before,
    packageWeightAndSize: packageWeightAndSizeForPublish(parcel),
  }));
  // JSON.stringify drops an undefined-valued property, so "present as
  // undefined" and "absent" are the same bytes. That is what makes the field
  // safe to wire while it is off, and it is asserted rather than assumed.
  assertEquals(JSON.stringify(withField), JSON.stringify(before));
  assert(!JSON.stringify(withField).includes("packageWeightAndSize"));

  // And with the flag on, the body genuinely changes - otherwise the case
  // above would pass against a field that never works at all.
  const on = withFlag("true", () => ({
    ...before,
    packageWeightAndSize: packageWeightAndSizeForPublish(parcel),
  }));
  assert(JSON.stringify(on).includes('"packageWeightAndSize":{"weight":{"value":'));
});

// --- The publish path reads the GARMENT category, not merchandising --------

const EBAY_ROUTE = new URL("../routes/flipdesk-ebay.ts", import.meta.url);

/** Comments stripped: a paragraph naming a column is not a read of it. */
function code(src: string): string {
  return src
    .replace(/\r\n?/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

Deno.test("assemblePublishContext selects garment_category and measurements", () => {
  // Dropping either from the SELECT does not break anything visibly: the row
  // arrives with both undefined, estimateParcel falls back to the `other` base
  // weight and STILL reports basis ["category"], and eBay is told a confident
  // wrong weight. There is no other detector for that, which is why it is
  // pinned on the select string itself.
  const src = code(Deno.readTextFileSync(EBAY_ROUTE));
  // Anchored on ebay_epid, which is unique to the publish-context read. An
  // earlier draft anchored on grade_label and matched a DIFFERENT select in
  // this file - a guard that checks the wrong string is a guard that reports
  // on nothing.
  const selects = [
    ...src.matchAll(/from\("inventory_items"\)\s*\.select\(\s*"([^"]*)"/g),
  ].map((m) => m[1]!).filter((cols) => cols.includes("ebay_epid"));
  assertEquals(selects.length, 1, "expected exactly one publish-context select");
  const columns = selects[0]!.split(",").map((c) => c.trim());
  assert(columns.includes("garment_category"), `select is missing garment_category: ${columns}`);
  assert(columns.includes("measurements"), `select is missing measurements: ${columns}`);
  // item_category is the merchandising value and must stay a separate read -
  // feeding it to the estimator is a confident number from a wrong input.
  assert(columns.includes("item_category"), "item_category read must not be dropped");
});

Deno.test("the estimator is fed garment_category, never the merchandising one", () => {
  // THE TRAP THIS CLOSES, named in US-2790 and reached once already by another
  // route: item_category is a merchandising value. Feeding it to estimateParcel
  // falls through to the `other` base weight and STILL reports basis
  // ["category"], so eBay would be told a confident wrong weight with nothing
  // anywhere reporting a problem. A DB-free test cannot see which column was
  // read any other way, so it is read off the function body.
  const src = code(Deno.readTextFileSync(EBAY_ROUTE));
  const start = src.indexOf("function predictedPackageForPublish(");
  assert(start >= 0, "predictedPackageForPublish is gone - has the wiring moved?");
  const body = src.slice(start, src.indexOf("\n}", start));
  assert(
    /garmentCategory:\s*item\.garment_category\b/.test(body),
    `predictedPackageForPublish does not read garment_category:\n${body}`,
  );
  assert(
    !/item\.item_category\b/.test(body),
    `predictedPackageForPublish reads item_category:\n${body}`,
  );
});

Deno.test("only the single-SKU publish attaches the field", () => {
  // A variation group is several parcels behind one listing, and revise re-PUTs
  // a listing that is already live. Both are deliberately left alone; a future
  // edit that sprays the field across every PUT should have to delete this.
  const src = code(Deno.readTextFileSync(EBAY_ROUTE));
  const attachments = src.match(/packageWeightAndSize:/g) ?? [];
  assertEquals(
    attachments.length,
    1,
    `expected exactly one packageWeightAndSize attachment, found ${attachments.length}`,
  );
});
