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
import { readFileSync } from "node:fs";
import { anonKeyFromDist } from "./probe-prod-readonly.mjs";

const SRC = readFileSync(new URL("./probe-prod-readonly.mjs", import.meta.url), "utf8");

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

// This tool's entire licence to run against production unattended is that it is
// READ-ONLY. That is a property of the source, not of anyone's intention, and it
// is exactly the kind of property that erodes one convenient addition at a time
// — three new probe blocks were added on 2026-08-17 alone. So it is pinned.
describe("the probe stays read-only", () => {
  const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("makes exactly one non-GET request, and it is the documented no-arg RPC probe", () => {
    const methods = [...stripped.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1]);
    expect(
      methods,
      "a new non-GET request appeared. The tool's safety argument is that every " +
        "RPC it POSTs to takes NO arguments, so PostgREST answers 401 or 404 " +
        "without executing anything. Anything else needs a session, not this tool.",
    ).toEqual(["POST"]);
  });

  it("only POSTs to the no-arg guarded list", () => {
    // A function that takes arguments cannot be proven from outside without a
    // genuinely write-shaped call — and the premise is that it might be
    // unguarded, so that call could do real damage on a real account.
    // The URL is the first argument, so it sits BEFORE `method:` — take a window
    // on both sides of the call rather than only after it.
    const post = stripped.match(/fetch\([\s\S]{0,500}?method:\s*"POST"[\s\S]{0,300}?\}\)/)?.[0] ?? "";
    expect(post, "the POST call could not be located").toBeTruthy();
    expect(
      post,
      "the POST no longer targets the interpolated no-arg function name",
    ).toMatch(/rpc\/\$\{fn\}/);
    expect(
      post,
      "the POST body is no longer empty — an argument means a real invocation",
    ).toMatch(/body:\s*"\{\}"/);
    // And the list it iterates may only hold argument-less functions.
    const list = stripped.match(/const NO_ARG_GUARDED = \[[\s\S]*?\];/)?.[0] ?? "";
    expect(list, "NO_ARG_GUARDED not found").toBeTruthy();
    expect(
      /\(/.test(list),
      "an entry in NO_ARG_GUARDED looks like a signature with parameters",
    ).toBe(false);
  });

  it("never sends a service-role or bearer credential", () => {
    expect(stripped).not.toMatch(/SERVICE_ROLE/i);
    expect(stripped).not.toMatch(/Authorization:\s*`?Bearer\s+\$\{(?!anon)/);
  });
});
