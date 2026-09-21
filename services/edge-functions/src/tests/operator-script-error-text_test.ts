// US-3437: an operator script must print a failure a person can act on.
//
//   deno test --allow-read --allow-env src/tests/operator-script-error-text_test.ts
//
// WHY `error.message` IS THE WRONG THING TO PRINT HERE, measured rather than
// styled: a supabase-js STORAGE error carries the stringified response body on
// `message`, so an empty body arrives as the two characters "{}" and the useful
// part sits on `name` and `status`. An AUTH admin failure is the same shape.
// Both produced log lines like
//
//     ! list failed at item-photos/: {}
//     [seed] FATAL: listUsers failed: {}
//
// in scripts whose entire job is to report. With supabaseErrorText they read
// "StorageApiError 404" and "AuthApiError 404", which names the missing service.
//
// SCOPED TO scripts/ ON PURPOSE. Runtime code under src/ logs for us; these log
// for a person who is deciding whether to delete a seller's photograph.
import { assert, assertEquals } from "@std/assert";

const DIR = new URL("../../scripts/", import.meta.url);

/**
 * `err`/`e` are caught EXCEPTIONS, where `.message` is exactly right. `error`
 * is this codebase's name for the second half of a supabase destructure, and
 * that is the one with the empty-body problem.
 */
const BARE = /\berror\.message\b/;

const files: { name: string; text: string }[] = [];
for await (const entry of Deno.readDir(DIR)) {
  if (entry.isFile && entry.name.endsWith(".ts")) {
    files.push({ name: entry.name, text: await Deno.readTextFile(new URL(entry.name, DIR)) });
  }
}

Deno.test("US-3437: the scan found the scripts (guards the guard)", () => {
  // Both assertions below pass on an empty directory listing.
  assert(files.length > 20, `only ${files.length} operator script(s) read`);
  const users = files.filter((f) => f.text.includes("supabaseErrorText(")).length;
  assert(
    users > 10,
    `only ${users} script(s) use supabaseErrorText, so the helper has been ` +
      "removed or the scan is reading the wrong directory",
  );
});

Deno.test("US-3437: no operator script prints a bare supabase error.message", () => {
  const offenders = files
    .filter((f) => BARE.test(f.text))
    .map((f) => f.name)
    .sort();
  assertEquals(
    offenders,
    [],
    "print supabaseErrorText(error) instead. A supabase storage or auth error " +
      "puts the stringified response body on `message`, so an empty body prints " +
      'as "{}" and the operator learns nothing from the one line that mattered.',
  );
});

Deno.test("US-3437: a caught exception's err.message is left alone", () => {
  // The other direction. `catch (err) { err.message }` is correct and common,
  // and a rule that flagged it would be switched off inside a week.
  assert(!BARE.test("catch (err) { console.error(err.message); }"));
  assert(!BARE.test("e instanceof Error ? e.message : String(e)"));
  assert(BARE.test("console.error(`read failed: ${error.message}`)"));
});
