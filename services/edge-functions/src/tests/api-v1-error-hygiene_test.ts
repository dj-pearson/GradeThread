// US-784: api-v1 image-processing responses stay a stable GENERIC envelope —
// raw validation/storage internals go to logs only, never the API response.
// A source-guard (the AC explicitly allows a grep-based regression guard).
import { assert } from "@std/assert";

const src = await Deno.readTextFile(new URL("../routes/api-v1.ts", import.meta.url));

Deno.test("the generic image-error message exists and is used", () => {
  assert(src.includes("IMAGE_ERROR_MESSAGE"), "generic message constant must exist");
  assert(
    src.includes("Image processing failed."),
    "the stable generic message text must be present",
  );
});

Deno.test("the leaky verdict.reason is NOT interpolated into a response message", () => {
  // The old code returned `Invalid image (…): ${verdict.reason}` to the caller.
  // verdict.reason must now appear only in a redactError(...) log path.
  assert(
    !/message:\s*`[^`]*verdict\.reason/.test(src),
    "verdict.reason must not be interpolated into an error response message",
  );
  // It IS still logged (via the imageProcessingError detail / a redacted log).
  assert(src.includes("verdict.reason"), "verdict.reason should still be logged for ops");
});

Deno.test("image error responses go through the generic helper (no raw image_type in message)", () => {
  assert(
    !/error:\s*\{\s*message:\s*`Failed to (process|upload) image:/.test(src),
    "image-processing error responses must use imageProcessingError, not an interpolated message",
  );
});

Deno.test("caught errors in api-v1 logs are redacted (no raw error object passed to console)", () => {
  // Every console.error in api-v1 that logs a caught value routes it through
  // redactError(...). Guard: no `console.error(... , <bareIdent>Error)` without redactError.
  const bareErrorLogs = [...src.matchAll(/console\.error\([^)]*,\s*([A-Za-z]+Error)\s*\)/g)]
    .map((m) => m[1]);
  assert(
    bareErrorLogs.length === 0,
    `caught errors must be wrapped in redactError(); found bare: ${bareErrorLogs.join(", ")}`,
  );
  assert(src.includes("redactError"), "redactError must be imported + used");
});
