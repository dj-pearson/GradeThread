// US-2640: the numbers and requirements the public API documents, against the
// code that enforces them.
//
// THE DEFECT THIS COMES FROM. `openapi.json` said, in two places, that a
// submission "Requires `front`, `back`, `label`, and at least one `detail*`
// image". The API requires `front`, `back` and `label` — nothing more. That
// third clause is the PRE-US-2397 rule: the owner decided on 2026-08-03 that
// refusing a garment with clean front/back/label coverage cost sellers grades
// they had the photos for, so the missing close-up became a confidence cap
// (0.6) plus human review rather than a refusal.
//
// The direction of the error is what makes it worth fixing. Overstating a
// requirement does not break a caller who complies; it turns away the caller who
// cannot. A customer whose garments have no photographable close-up reads the
// spec and concludes the API will not grade them, when it will.
//
// The other claims here are currently TRUE and are pinned because this class has
// already shipped once: US-2515 removed an "Enterprise, 600/120" row from the
// public rate table for a plan nobody could buy, after it had been quoted
// publicly. A number on a page a customer plans against needs a gate, not a
// comment saying it mirrors the server.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SPEC = "services/edge-functions/src/lib/openapi-spec.ts";
const ROUTES = "services/edge-functions/src/routes/api-v1.ts";
const RATE = "services/edge-functions/src/middleware/api-v1-rate.ts";
const IDEMPOTENCY = "services/edge-functions/src/middleware/api-idempotency.ts";
const BATCH = "services/edge-functions/src/lib/grading-batch.ts";
const PAGE = "src/pages/marketing/developers.tsx";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/** A named numeric constant's value, from its declaration. */
function constant(file: string, name: string): number {
  const m = new RegExp(`${name}\\s*(?::\\s*\\w+)?\\s*=\\s*(\\d[\\d_]*)`).exec(read(file));
  expect(m, `${name} not found in ${file}`).toBeTruthy();
  return Number(m![1]!.replace(/_/g, ""));
}

describe("US-2640: the API's public contract matches the code", () => {
  it("the spec does not claim a detail image is required", () => {
    // Two places said it. Both are assertions about what a caller MUST send, so
    // both have to go — a schema description is read by codegen and by anyone
    // debugging a 400.
    const spec = read(SPEC);
    expect(spec, "the POST description still requires a detail image").not.toMatch(
      /at least one `?detail\*/i,
    );
    expect(spec, "the images schema still requires a detail image").not.toMatch(
      /label \+ ≥1 detail/i,
    );
  });

  it("the required set the spec names is the set the code enforces", () => {
    const required = [
      ...read(ROUTES).matchAll(/const REQUIRED_IMAGE_TYPES = \[([^\]]+)\]/g),
    ]
      .flatMap((m) => [...m[1]!.matchAll(/"([^"]+)"/g)].map((t) => t[1]!))
      .sort();
    expect(required, "api-v1's required image types changed").toEqual(["back", "front", "label"]);
    const spec = read(SPEC);
    for (const t of required) {
      expect(spec, `the spec never mentions the required ${t} image`).toMatch(
        new RegExp(`\`?${t}\`?`),
      );
    }
  });

  it("the spec's image ceiling equals the enforced one", () => {
    // MAX_IMAGES_PER_SUBMISSION is IMAGE_TYPES.length, i.e. DERIVED. Adding one
    // image type silently makes a hardcoded 14 in the spec wrong.
    const types = [...read(ROUTES).matchAll(/const IMAGE_TYPES = \[([\s\S]*?)\] as const/g)]
      .flatMap((m) => [...m[1]!.matchAll(/"([^"]+)"/g)].map((t) => t[1]!));
    expect(types.length, "IMAGE_TYPES was not parsed").toBeGreaterThan(5);
    expect(read(SPEC)).toMatch(new RegExp(`max ${types.length} images`));
    expect(read(SPEC)).toMatch(new RegExp(`maxItems: ${types.length}`));
  });

  it("the spec's batch cap and key length equal the enforced ones", () => {
    const spec = read(SPEC);
    expect(spec).toMatch(new RegExp(`up to ${constant(BATCH, "MAX_BATCH_ITEMS")} garments`));
    expect(spec).toMatch(
      new RegExp(`${constant(IDEMPOTENCY, "MAX_KEY_LENGTH")} characters`),
    );
  });

  it("the public rate table lists every buyable tier and no unbuyable one", () => {
    // The US-2515 defect exactly: `enterprise` and `super_admin` are real server
    // tiers that nobody can purchase — quoting them publicly promises capacity
    // that cannot be granted. So this checks BOTH directions.
    const server = new Map<string, { read: number; write: number }>();
    const block = read(RATE).slice(read(RATE).indexOf("API_RATE_TIERS"));
    for (const m of block.matchAll(/(\w+):\s*\{\s*read:\s*(\d+),\s*write:\s*(\d+)\s*\}/g)) {
      server.set(m[1]!, { read: Number(m[2]), write: Number(m[3]) });
    }
    expect(server.size, "API_RATE_TIERS was not parsed").toBeGreaterThanOrEqual(4);

    const page = read(PAGE);
    const rows = [...page.matchAll(/plan:\s*"([^"]+)",\s*read:\s*(\d+),\s*write:\s*(\d+)/g)].map(
      (m) => ({ plan: m[1]!, read: Number(m[2]), write: Number(m[3]) }),
    );
    expect(rows.length, "the page's RATE_TIERS was not parsed").toBeGreaterThanOrEqual(4);

    const BUYABLE = ["free", "starter", "pro", "business"];
    for (const key of BUYABLE) {
      const tier = server.get(key);
      expect(tier, `${key} vanished from API_RATE_TIERS`).toBeTruthy();
      expect(
        rows.some((r) => r.read === tier!.read && r.write === tier!.write),
        `no public row matches ${key} (${tier!.read}/${tier!.write})`,
      ).toBe(true);
    }
    for (const [key, tier] of server) {
      if (BUYABLE.includes(key)) continue;
      expect(
        rows.some((r) => r.read === tier.read && r.write === tier.write),
        `the page quotes ${key} (${tier.read}/${tier.write}), a tier nobody can buy`,
      ).toBe(false);
    }
  });
});
