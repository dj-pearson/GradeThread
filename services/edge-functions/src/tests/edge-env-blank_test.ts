// A BLANK EDGE_ENV must not stop the service believing it is in production.
//
// FOUND 2026-08-16 while reading features.pages_origin_bypass for US-2612.
// `edgeEnv()` was `Deno.env.get("EDGE_ENV") ?? Deno.env.get("DENO_ENV") ??
// "production"`, and `??` falls through on null/undefined but NEVER on an empty
// string. So `EDGE_ENV=` — a blank field in the Coolify UI, or a trailing `=`
// in an env file — resolved to `""`, which is not "production".
//
// Measured, not argued:
//
//   EDGE_ENV absent → missingRequiredEnv() = [STRIPE_SECRET_KEY,
//                     STRIPE_WEBHOOK_SECRET, FLIPDESK_INTERNAL_JOB_SECRET,
//                     EDGE_ENCRYPTION_KEY, CERT_SIGNING_KEY, API_KEY_PEPPER]
//   EDGE_ENV=""     → missingRequiredEnv() = []
//
// So the blank value made /health/ready report READY with none of those
// secrets, disabled the pages_origin_bypass reporting US-2612 waits on, made
// isProduction() false wherever it gates behaviour, and short-circuited
// assertAdminMfaConfig — the boot check that refuses to start with admin MFA
// off.
//
// Same defect as the release identity had (lib/release-identity.ts states the
// rule: fall through on a placeholder VALUE, not merely on an unset key). That
// fix never reached this module, and the two are three files apart.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  assertAdminMfaConfig,
  isKnownEdgeEnv,
  isProductionEnv,
  KNOWN_EDGE_ENVS,
  resolveEdgeEnv,
} from "../lib/env.ts";

const get = (env: Record<string, string>) => (k: string) => env[k];

Deno.test("a blank EDGE_ENV resolves to production, like an absent one", () => {
  assertEquals(resolveEdgeEnv(get({})), "production");
  assertEquals(resolveEdgeEnv(get({ EDGE_ENV: "" })), "production");
  assertEquals(resolveEdgeEnv(get({ EDGE_ENV: "   " })), "production");
});

Deno.test("a blank EDGE_ENV falls through to DENO_ENV before defaulting", () => {
  // Order still matters: an explicit DENO_ENV should win over the default,
  // exactly as it did before, or a staging box silently becomes production.
  assertEquals(resolveEdgeEnv(get({ EDGE_ENV: "", DENO_ENV: "staging" })), "staging");
  assertEquals(resolveEdgeEnv(get({ DENO_ENV: "test" })), "test");
});

Deno.test("an explicit value still wins, and is normalised", () => {
  assertEquals(resolveEdgeEnv(get({ EDGE_ENV: "test" })), "test");
  assertEquals(resolveEdgeEnv(get({ EDGE_ENV: "  PRODUCTION  " })), "production");
  // EDGE_ENV beats DENO_ENV when both are real.
  assertEquals(resolveEdgeEnv(get({ EDGE_ENV: "test", DENO_ENV: "production" })), "test");
});

Deno.test("a blank EDGE_ENV cannot skip the admin-MFA boot assertion", () => {
  // The check exists to refuse to boot with admin MFA disabled in production.
  // It carried its own copy of the `??` chain, so a blank value returned early
  // and it simply did not run.
  assertThrows(
    () => assertAdminMfaConfig(get({ EDGE_ENV: "", ADMIN_MFA_ENFORCED: "false" })),
    Error,
    "Refusing to start",
  );
  // …and the deliberate escape hatch still works, so this is not a tightening
  // of the enrollment window.
  assertAdminMfaConfig(
    get({ EDGE_ENV: "", ADMIN_MFA_ENFORCED: "false", ADMIN_MFA_ENROLLMENT_WINDOW: "true" }),
  );
});

// ── US-2660 AC3: the same hole one step along ────────────────────────
//
// The blank fix left a sibling: any NON-empty string was taken as-is, so
// `EDGE_ENV=prod` — a plausible typo in a field that is edited by hand — was
// not "production" and disabled every production-only control exactly as the
// blank did. An unrecognised name now gets production's behaviour.

Deno.test("US-2660 AC3: an unrecognised EDGE_ENV is treated as production", () => {
  // The typos this is for.
  for (const typo of ["prod", "produciton", "Production ", "live", "prd"]) {
    const env = resolveEdgeEnv(get({ EDGE_ENV: typo }));
    assert(
      isProductionEnv(env),
      `EDGE_ENV=${typo} resolved to "${env}" and is NOT being treated as production`,
    );
  }
});

Deno.test("US-2660 AC3: the recognised non-production names still are not production", () => {
  // The other half, and the reason a REFUSING whitelist was rejected: staging,
  // development and test must keep behaving as themselves.
  for (const name of ["staging", "development", "test"]) {
    const env = resolveEdgeEnv(get({ EDGE_ENV: name }));
    assertEquals(env, name);
    assert(isKnownEdgeEnv(env), `${name} is missing from KNOWN_EDGE_ENVS`);
    assert(!isProductionEnv(env), `${name} is being treated as production`);
  }
  assert(isProductionEnv("production"));
  assert(isKnownEdgeEnv("production"));
});

Deno.test("US-2660 AC3: an unrecognised EDGE_ENV cannot skip the admin-MFA boot assertion", () => {
  // The concrete cost of the old behaviour: `EDGE_ENV=prod` with admin MFA off
  // booted happily and served admin routes without the AAL2 gate.
  assertThrows(
    () => assertAdminMfaConfig(get({ EDGE_ENV: "prod", ADMIN_MFA_ENFORCED: "false" })),
    Error,
    "Refusing to start",
  );
});

Deno.test("US-2660 AC3: KNOWN_EDGE_ENVS covers every name the deploy files use", async () => {
  // Read off the deploy files rather than trusted to memory. A new environment
  // added to a compose file without being registered here would be silently
  // treated as production, which is safe but confusing — this makes it loud at
  // the point the compose file changes instead.
  const files = [
    "./docker-compose.coolify.yml",
    "./docker-compose.staging.yml",
    "./docker-compose.dev.yml",
    "./.env.example",
    "./.env.staging.example",
  ];
  const declared = new Set<string>();
  for (const f of files) {
    let src: string;
    try {
      src = await Deno.readTextFile(f);
    } catch {
      continue; // a compose file may legitimately not exist in every checkout
    }
    for (const m of src.matchAll(/EDGE_ENV\s*[:=]\s*"?([A-Za-z_]+)"?/g)) {
      declared.add(m[1].toLowerCase());
    }
  }
  assert(declared.size > 0, "no EDGE_ENV value found in any deploy file — the scan is broken");
  const unregistered = [...declared].filter((d) => !isKnownEdgeEnv(d));
  assertEquals(
    unregistered,
    [],
    `a deploy file declares EDGE_ENV values that are not in KNOWN_EDGE_ENVS ` +
      `(${KNOWN_EDGE_ENVS.join(", ")}), so they would be treated as production: ` +
      unregistered.join(", "),
  );
});

Deno.test("no module keeps its own copy of the EDGE_ENV chain", async () => {
  // There were THREE. lib/env.ts had two (edgeEnv and assertAdminMfaConfig) and
  // routes/health.ts had a third gating /health/_throw — an unauthenticated
  // endpoint that throws on every call, which a blank EDGE_ENV made reachable
  // in production. Each copy is another place the blank has to be handled, and
  // the one that mattered most was the one furthest from the others.
  //
  // Scanned rather than remembered: a fourth copy is a new instance of a defect
  // that has now shipped twice in this repo.
  const offenders: string[] = [];
  for await (const entry of walk("./src")) {
    if (!entry.endsWith(".ts") || entry.includes("_test.")) continue;
    const src = await Deno.readTextFile(entry);
    // The shape: a nullish-coalesce reading EDGE_ENV, anywhere but the resolver.
    if (!/Deno\.env\.get\(\s*"EDGE_ENV"\s*\)\s*\?\?/.test(src)) continue;
    if (entry.split("\\").join("/").endsWith("src/lib/env.ts")) continue; // the resolver itself
    offenders.push(entry.split("\\").join("/"));
  }
  if (offenders.length > 0) {
    throw new Error(
      "These read EDGE_ENV with `??` instead of going through resolveEdgeEnv()/" +
        "isProduction(). `??` does not fall through on an empty string, so a " +
        `blank EDGE_ENV defeats them:\n  ${offenders.join("\n  ")}`,
    );
  }
});

Deno.test("no module compares the edge env to \"production\" by hand", async () => {
  // AC4, one level up from the `??` scan below. Routing every site through
  // resolveEdgeEnv() fixed the BLANK; it did nothing for the TYPO, because each
  // site still asked `=== "production"` and `prod` is not that string. The
  // decision belongs in one predicate (isProductionEnv) so there is one place to
  // change when a rule like this one lands.
  //
  // Scoped to the EDGE env deliberately. Other modules legitimately compare a
  // DIFFERENT variable to "production" — the eBay sandbox switch, the App Store
  // billing environment, APNs host selection — and none of them is EDGE_ENV.
  // Matching those would make this scan noise, and a noisy guard gets deleted.
  const offenders: string[] = [];
  for await (const entry of walk("./src")) {
    if (!entry.endsWith(".ts") || entry.includes("_test.")) continue;
    const path = entry.split("\\").join("/");
    if (path.endsWith("src/lib/env.ts")) continue; // where the decision lives
    const src = await Deno.readTextFile(entry);
    for (const line of src.split("\n")) {
      if (line.trimStart().startsWith("//")) continue; // a comment about the rule is not the rule
      // The shape: something env-ish compared straight to the literal.
      if (/\b(edgeEnv\(\)|\benv\b|d\.env|EDGE_ENV)\s*[!=]==\s*"production"/.test(line)) {
        offenders.push(`${path}: ${line.trim()}`);
      }
    }
  }
  assertEquals(
    offenders,
    [],
    "These compare the edge environment to \"production\" by hand instead of " +
      "calling isProduction() / isProductionEnv(). A bare comparison treats an " +
      "unrecognised value (EDGE_ENV=prod) as NON-production and switches off " +
      `every control that site guards:\n  ${offenders.join("\n  ")}`,
  );
});

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) yield* walk(p);
    else yield p;
  }
}
