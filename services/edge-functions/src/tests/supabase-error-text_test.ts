// US-3436: a diagnostic that refuses must be able to say why.
//
//   deno test --allow-read --allow-env src/tests/supabase-error-text_test.ts
import { assertEquals } from "@std/assert";
import { supabaseErrorText } from "../lib/supabase-error-text.ts";

Deno.test("US-3436: a StorageApiError with an empty body names itself and its status", () => {
  // THE MEASURED CASE. supabase-js storage puts the stringified response body
  // on `message`, so an empty body arrives as the two characters "{}" and the
  // only real information is on `name` and `status`.
  const err = Object.assign(new Error("{}"), {
    name: "StorageApiError",
    status: 404,
    __isStorageError: true,
  });
  assertEquals(supabaseErrorText(err), "StorageApiError 404");
});

Deno.test("US-3436: a real message is printed as-is, without being decorated", () => {
  // The other direction: PostgREST errors already read well, and appending a
  // name and a status to them would make the common case worse.
  const err = { message: "permission denied for table item_photos", code: "42501" };
  assertEquals(
    supabaseErrorText(err),
    "permission denied for table item_photos (42501)",
  );
});

Deno.test("US-3436: details are appended when they add something", () => {
  const err = { message: "column does not exist", code: "42703", details: "no such column: foo" };
  assertEquals(
    supabaseErrorText(err),
    "column does not exist (42703) - no such column: foo",
  );
});

Deno.test("US-3436: the other empty shapes are treated the same as {}", () => {
  for (const message of ["", "   ", "[object Object]", "null"]) {
    const err = Object.assign(new Error(message), { name: "StorageApiError", status: 500 });
    assertEquals(supabaseErrorText(err), "StorageApiError 500", `message: ${message}`);
  }
});

Deno.test("US-3436: a statusCode string is read as a status", () => {
  // PostgREST and the storage client disagree on the field name, and one of
  // them sends it as a string.
  const err = { message: "{}", name: "StorageApiError", statusCode: "400" };
  assertEquals(supabaseErrorText(err), "StorageApiError 400");
});

Deno.test("US-3436: it never returns an empty string", () => {
  // The whole point: a log line that trails off tells an operator nothing and
  // reads like the script stopped mid-sentence.
  for (const input of [null, undefined, "", {}, 0, []]) {
    const text = supabaseErrorText(input);
    assertEquals(text.length > 0, true, `empty for ${JSON.stringify(input)}`);
  }
});
