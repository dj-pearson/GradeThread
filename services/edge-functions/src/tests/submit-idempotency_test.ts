// US-3532: a retried grade submit returns the first submission.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  isIdempotencyConflict,
  parseIdempotencyKey,
  replayBody,
} from "../lib/submit-idempotency.ts";

Deno.test("US-3532: a UUID-like key is accepted; junk and absence are ignored", () => {
  assertEquals(
    parseIdempotencyKey("0b8f2a1e-5b2c-4c1f-9d7a-3e1f2a4b5c6d"),
    "0b8f2a1e-5b2c-4c1f-9d7a-3e1f2a4b5c6d",
  );
  assertEquals(parseIdempotencyKey("  abcdefgh  "), "abcdefgh");
  assertEquals(parseIdempotencyKey(undefined), null);
  assertEquals(parseIdempotencyKey("short"), null);
  assertEquals(parseIdempotencyKey("has spaces in it"), null);
  assertEquals(parseIdempotencyKey("x".repeat(129)), null);
});

Deno.test("US-3532: only the idempotency index's 23505 counts as the race", () => {
  assert(isIdempotencyConflict({
    code: "23505",
    message:
      'duplicate key value violates unique constraint "submissions_owner_idempotency_key"',
  }));
  assert(
    !isIdempotencyConflict({ code: "23505", message: "some_other_index" }),
  );
  assert(
    !isIdempotencyConflict({
      code: "23503",
      message: "submissions_owner_idempotency_key",
    }),
  );
  assert(!isIdempotencyConflict(null));
});

Deno.test("US-3532: the replay has the fresh-submit shape, marked replayed", () => {
  assertEquals(replayBody({ id: "s1", status: "processing" }), {
    submissionId: "s1",
    status: "processing",
    payment_status: null,
    replayed: true,
  });
  // A batch client sorts a replayed row by this (bulk-submission.tsx).
  assertEquals(
    replayBody({ id: "s2", status: "pending", payment_status: "unpaid" }).payment_status,
    "unpaid",
  );
});

Deno.test("US-3532: the replay check runs before any charge, the key is stored, and CORS allows it", async () => {
  const read = (p: string) => Deno.readTextFile(new URL(p, import.meta.url));
  const grade = await read("../routes/grade.ts");
  const main = await read("../main.ts");
  const lookup = grade.indexOf(
    "await findSubmissionByKey(ownerId, idempotencyKey)",
  );
  assert(lookup > 0 && lookup < grade.indexOf("runPaymentPrecedence("));
  assert(grade.includes("idempotency_key: idempotencyKey,"));
  assert(grade.includes("isIdempotencyConflict(submissionError)"));
  assert(main.includes('"Idempotency-Key",'));
});
