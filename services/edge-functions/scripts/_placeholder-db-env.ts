// Import this FIRST in any script that renders or computes without querying.
//
// ── WHY IT EXISTS ────────────────────────────────────────────────────────────
// `src/lib/supabase.ts` reads SUPABASE_URL and THROWS at module load, then
// constructs the client. Anything whose import graph reaches it therefore needs
// a database credential to *start*, even if it never issues a query. Three
// scripts were broken by that and each failed before printing its own usage
// line:
//
//   scripts/render-cron-docs.ts    prints a table from a constant array
//   scripts/render-cron-setup.ts   prints the 67-task Coolify setup guide
//   scripts/measure-eval.ts        scores photos against ground truth
//
// None of the three references `supabaseAdmin`, directly or in the libraries
// they import. The requirement is entirely transitive.
//
// ── WHY A MODULE AND NOT TWO LINES AT THE TOP ────────────────────────────────
// ES `import` statements are HOISTED: every import in a module runs before any
// top-level statement in it. So `Deno.env.set(...)` written above the imports
// executes AFTER them and changes nothing — which is exactly how the first
// attempt at this failed, silently looking correct. Imports run in ORDER,
// though, so a side-effecting module placed first is the one arrangement that
// works without rewriting every import as a dynamic one.
//
// ── WHAT IT IS NOT ───────────────────────────────────────────────────────────
// Not a way to run a script against a database it lacks credentials for. A real
// value always wins; these are a floor for modules that will never dial out. If
// a script using this ever DOES query, it will do so against localhost and fail
// loudly, which is the correct outcome.
//
// The root fix is a lazily-constructed client — `supabaseAdmin` built on first
// use rather than on import — so a module that never queries never needs a
// credential. The boot-time loudness that the eager throw provides is already
// duplicated, and better, by `assertRequiredEnv()` in main.ts: it runs before
// `Deno.serve` and names EVERY missing variable at once, where the import-time
// throw names only the first one it reaches.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_KEY") ?? "render-only-placeholder",
);
