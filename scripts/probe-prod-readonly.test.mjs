// The probe talks to production, so only its key extraction is unit-testable —
// and that is the half worth pinning, because getting it wrong reads as "no key
// found" and silently skips every RPC question rather than failing.
//
// The network half is exercised by running the tool. What is tested here is the
// part that decides whether the tool does anything at all.
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anonKeyFromDist } from "./probe-prod-readonly.mjs";

/** A syntactically real JWT with the given claims. Not signed — nothing verifies it. */
function jwt(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.${"s".repeat(43)}`;
}

function withDist(files) {
  const dir = mkdtempSync(join(tmpdir(), "probe-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

describe("anonKeyFromDist", () => {
  it("finds the anon key in a bundle", () => {
    const key = jwt({ role: "anon", iss: "supabase" });
    const dir = withDist({ "app.js": `const k="${key}";` });
    try {
      expect(anonKeyFromDist(dir)).toBe(key);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("REFUSES a service-role token even when one is present", () => {
    // The whole safety claim of this tool is that it uses only what production
    // already serves to the public. A service_role key in a bundle would be a
    // separate emergency, and picking it up here would silently turn a
    // read-only probe into an authenticated one.
    const svc = jwt({ role: "service_role" });
    const dir = withDist({ "app.js": `const k="${svc}";` });
    try {
      expect(anonKeyFromDist(dir)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("picks the anon key out of a bundle that also holds another token", () => {
    const svc = jwt({ role: "service_role" });
    const anon = jwt({ role: "anon" });
    const dir = withDist({ "a.js": `x="${svc}"`, "b.js": `y="${anon}"` });
    try {
      expect(anonKeyFromDist(dir)).toBe(anon);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("returns null rather than throwing when there is no dist", () => {
    // The tool degrades to the health and header probes in that case. Throwing
    // would take the answerable questions down with the unanswerable ones.
    expect(anonKeyFromDist(join(tmpdir(), "definitely-not-here-" + process.pid))).toBeNull();
  });

  it("ignores a JWT-shaped string that is not a JWT", () => {
    const dir = withDist({ "app.js": 'const k="eyJabcdefghijklmnopqrst.eyJnotvalidbase64json!!.sig";' });
    try {
      expect(anonKeyFromDist(dir)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
