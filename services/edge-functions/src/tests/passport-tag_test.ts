// US-1096: physical Garment Passport tag code generation. Pure functions — no
// DB, no env.
import { assert, assertEquals } from "@std/assert";
import {
  generateTagCode,
  isValidTagCode,
  normalizeTagCode,
  tagScanUrl,
} from "../lib/passport-tag.ts";

Deno.test("generateTagCode: grouped, unambiguous Crockford base32, unique", () => {
  const a = generateTagCode();
  const b = generateTagCode();
  // Display form is XXXX-XXXX-XX.
  assert(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{2}$/.test(a), `bad format: ${a}`);
  // No ambiguous characters (I, L, O, U excluded).
  assert(!/[ILOU]/.test(a), "must exclude ambiguous letters");
  assert(a !== b, "two codes must differ");
  // The normalized (ungrouped) code is a valid 10-char tag code.
  assert(isValidTagCode(a));
});

Deno.test("normalizeTagCode: strips dashes/spaces, uppercases", () => {
  assertEquals(normalizeTagCode("ab12-cd34-ef"), "AB12CD34EF");
  assertEquals(normalizeTagCode(" AB12 CD34 EF "), "AB12CD34EF");
  // Round-trips a generated code to its 10-char canonical key.
  const code = generateTagCode();
  assertEquals(normalizeTagCode(code).length, 10);
});

Deno.test("isValidTagCode: rejects wrong length / ambiguous chars", () => {
  assert(isValidTagCode("AB12CD34EF"));
  assert(isValidTagCode("ab12-cd34-ef")); // normalized first
  assert(!isValidTagCode("AB12CD34E")); // 9 chars
  assert(!isValidTagCode("AB12CD34EFG")); // 11 chars
  assert(!isValidTagCode("ABILOUCD34")); // contains excluded letters → normalizes shorter
});

Deno.test("tagScanUrl: builds the public /t/:code entry point", () => {
  assertEquals(tagScanUrl("https://gradethread.com/", "ab12-cd34-ef"), "https://gradethread.com/t/AB12CD34EF");
  assertEquals(tagScanUrl("https://gradethread.com", "AB12CD34EF"), "https://gradethread.com/t/AB12CD34EF");
});
