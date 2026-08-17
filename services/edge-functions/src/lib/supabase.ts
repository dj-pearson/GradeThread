import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * The service-role client — bypasses RLS, so every query through it must be
 * tenant-scoped by hand (US-268).
 *
 * BUILT ON FIRST USE, NOT AT IMPORT (US-2661). This module used to read the env
 * and throw at MODULE LOAD, which meant anything whose import graph reached it
 * needed a database credential to START, whether or not it ever ran a query.
 * That is not hypothetical: three operator scripts died on `SUPABASE_URL is not
 * set` before printing their own usage line, and none of the three touches the
 * database — render-cron-docs.ts prints a table from a constant array,
 * render-cron-setup.ts prints the Coolify setup guide US-2313 is about
 * installing, and measure-eval.ts is the accuracy gate US-1582 asks an operator
 * to run. The requirement was purely transitive, and the error named a variable
 * the script had no use for.
 *
 * THIS DOES NOT WEAKEN THE DEPLOY CHECK, which is the thing to verify before
 * touching it. main.ts calls assertRequiredEnv() before Deno.serve, and both
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are in CORE_REQUIRED. That
 * assertion is strictly better than the import-time throw ever was: it names
 * EVERY missing variable at once, where the throw named only the first one the
 * import chain happened to reach.
 */

let client: SupabaseClient | null = null;

/** Read the env and construct once. Throws by NAME so the message stays useful. */
function realClient(): SupabaseClient {
  if (client) return client;

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  // Accept either name. Supabase's canonical env var is SUPABASE_SERVICE_ROLE_KEY,
  // but SUPABASE_SERVICE_KEY is a common shorthand.
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_KEY");

  if (!supabaseUrl) {
    throw new Error("SUPABASE_URL is not set");
  }
  if (!supabaseServiceKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY) is not set",
    );
  }

  client = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
  return client;
}

/**
 * ⚠ THE BINDING IS LOAD-BEARING, and getting it wrong here would be invisible
 * in unit tests and catastrophic in production.
 *
 * `supabase.from()` is `return this.rest.from(relation)` — it works only while
 * attached to the client (vault/70-agent/states-that-look-normal.md, shape 1,
 * where a hoisted `.from` rendered as a seller with an empty inventory and the
 * unit tests stayed green because the mock was a `this`-free arrow).
 *
 * So the trap does two specific things rather than a bare `Reflect.get`:
 *  - the RECEIVER is the real client, so any getter runs with the `this` it
 *    expects rather than with the proxy;
 *  - functions come back BOUND to the real client, so `this` inside them is the
 *    genuine object. That matters beyond `.rest`: supabase-js uses private class
 *    fields, and a private read through a proxy throws outright.
 *
 * Nothing stubs or reassigns this export — all 14 test files that mention
 * `supabaseAdmin` scan source text rather than calling it — so there is no `set`
 * trap to preserve.
 */
export const supabaseAdmin: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const c = realClient();
    const value = Reflect.get(c, prop, c);
    return typeof value === "function" ? value.bind(c) : value;
  },
  has(_target, prop) {
    return Reflect.has(realClient(), prop);
  },
});

/** Test seam: drop the memoised client so the next use re-reads the env. */
export function resetSupabaseAdminForTests(): void {
  client = null;
}
