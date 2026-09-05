// US-2351 AC7: GoTrue's OTP expiry, made observable instead of looked up.
//
// The story marked this OPERATOR — "confirm the GoTrue OTP TTL in prod" — and
// it did not have to be. GoTrue puts `otp_expiry` in the payload of every
// send-email hook call, and this codebase received it and used it only to write
// "expires in N minutes" into the email copy. The number was passing through
// production on every password reset and nobody could read it.
//
// It is not trivia. Impersonation (US-2351) mints a magiclink through
// adminGenerateLink, and supabase/auth applies `config.Mailer.OtpExp` to signup,
// invite, recovery and magiclink alike through a single `isOtpExpired()` call —
// read from internal/api/verify.go at v2.174.0, the version production runs. So
// this value is the OTHER ceiling on an impersonation token, and the 30-minute
// cap enforced in code is only the shorter of the two.
import assert from "node:assert/strict";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key");

const { OTP_EXPIRY_KEY, recordOtpExpiry, resetOtpExpiryCache } = await import(
  "../routes/auth-hooks.ts"
);
const { otpExpiryReadiness } = await import("../routes/health.ts");

function recorder() {
  const writes: number[] = [];
  return {
    writes,
    write: (v: number) => {
      writes.push(v);
      return Promise.resolve({ error: null });
    },
  };
}

Deno.test("US-2351: a real expiry is recorded once, not once per email", async () => {
  resetOtpExpiryCache();
  const r = recorder();
  await recordOtpExpiry(3600, { write: r.write });
  await recordOtpExpiry(3600, { write: r.write });
  await recordOtpExpiry(3600, { write: r.write });
  assert.deepEqual(r.writes, [3600], "a busy hour must not be an upsert per email");

  // A CHANGE is written, because that is the whole point of observing it.
  await recordOtpExpiry(900, { write: r.write });
  assert.deepEqual(r.writes, [3600, 900]);
});

Deno.test("US-2351: junk is ignored rather than recorded", async () => {
  resetOtpExpiryCache();
  const r = recorder();
  for (const bad of [undefined, null, "3600", 0, -1, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
    await recordOtpExpiry(bad, { write: r.write });
  }
  assert.deepEqual(r.writes, [], "a malformed payload wrote a value anyway");
});

Deno.test("US-2351: a write failure NEVER throws into the hook", async () => {
  // The hook must answer 200. A non-200 fails the user's signup or login
  // outright, and no diagnostic is worth that — a check that can break
  // authentication is not a check, it is an outage with a nice comment.
  resetOtpExpiryCache();
  await recordOtpExpiry(3600, {
    write: () => Promise.resolve({ error: { message: "db down" } }),
  });
  await recordOtpExpiry(3600, {
    write: () => Promise.reject(new Error("connection reset")),
  });
  await recordOtpExpiry(3600, {
    write: () => {
      throw new Error("synchronous boom");
    },
  });

  // And a failed write must NOT poison the cache: the next email has to try
  // again, or one blip means the value is never recorded at all.
  const r = recorder();
  await recordOtpExpiry(3600, { write: r.write });
  assert.deepEqual(r.writes, [3600], "a failed write latched and blocked the retry");
});

Deno.test("US-2351: never-observed says so, and says what it cannot tell apart", () => {
  for (const v of [null, 0, -5, Number.NaN]) {
    const line = otpExpiryReadiness(v as number | null);
    assert.match(line, /never observed/, `${v} did not read as unobserved`);
    // The two causes are different problems and the line must not imply one.
    assert.match(line, /impersonation/i);
  }
});

Deno.test("US-2351: an observed expiry names which limit actually binds", () => {
  // The number alone is not the answer. Which of the two ceilings is lower is.
  const hour = otpExpiryReadiness(3600);
  assert.match(hour, /3600s/);
  assert.match(hour, /~60m/);
  assert.match(hour, /30m code cap is the binding limit/);

  const short = otpExpiryReadiness(600);
  assert.match(short, /~10m/);
  assert.match(short, /GoTrue's 10m is the binding limit/);

  // The boundary: equal to the cap means GoTrue binds, because at 30m exactly
  // the two expire together and reporting the code cap would overstate what
  // stops an abandoned session.
  assert.match(otpExpiryReadiness(1800), /GoTrue's 30m is the binding limit/);
});

Deno.test("US-2351: the settings key is namespaced and is not a tunable", () => {
  assert.equal(OTP_EXPIRY_KEY, "ops.gotrue_otp_expiry_seconds");
});
