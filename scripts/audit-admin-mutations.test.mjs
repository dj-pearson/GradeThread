// US-2459: the declaration slicer decides whether an admin action counts as
// audited, and nothing tested it directly.
//
// Its only coverage was src/test/admin-audit-policy.test.ts, which asserts the
// OUTCOME over the real files — so a slicer that over-attributes stays green as
// long as the EXEMPT/OPEN maps happen to match whatever it produced. That is
// how 48 declarations came to have slices containing `writeAuditLog(` while
// their real bodies did not, masking six unaudited admin mutations.
//
// These fixtures are the shapes that broke it.

import { describe, expect, it } from "vitest";
import { declarations } from "./audit-admin-mutations.mjs";

describe("US-2459: declarations() brace-matches", () => {
  it("a constant does not swallow the routes that follow it", () => {
    // THE ONE THAT MASKED SIX ROUTES. UUID_RE in admin-users.ts is 33 bytes and
    // its old slice was 15 KB — and every `:id` route references it, so every
    // one of them inherited whatever audit calls happened to sit in between.
    const code = [
      "const UUID_RE = /^[0-9a-f-]{36}$/;",
      'adminRoutes.post("/a", async (c) => {',
      "  await writeAuditLog(c, {});",
      "});",
    ].join("\n");
    const body = declarations(code).get("UUID_RE");
    expect(body).toBe("const UUID_RE = /^[0-9a-f-]{36}$/;");
    expect(body).not.toContain("writeAuditLog");
  });

  it("a function stops at its own closing brace", () => {
    const code = [
      "function helper(x) {",
      "  if (x) { return 1; }",
      "  const o = { a: 1 };",
      "  return o;",
      "}",
      'adminRoutes.post("/b", async (c) => {',
      "  await writeAuditLog(c, {});",
      "});",
    ].join("\n");
    const body = declarations(code).get("helper");
    expect(body).toContain("return o;");
    expect(body).not.toContain("writeAuditLog");
  });

  it("an arrow const keeps its whole body", () => {
    // The wrapper shape the report depends on: admin-grading and admin-claims
    // both define a local auditLog over writeAuditLog and every route calls it.
    // Cutting this short would swing the report the other way and report 42
    // audited routes as unaudited, which is what the first version of the
    // script did.
    const code = [
      "const auditLog = (c, action) => {",
      "  return writeAuditLog(c, { action });",
      "};",
      "const NEXT = 1;",
    ].join("\n");
    const body = declarations(code).get("auditLog");
    expect(body).toContain("writeAuditLog");
    expect(body).not.toContain("const NEXT");
  });

  it("a declaration with no block ends at its semicolon", () => {
    const code = 'const A = "x";\nconst B = "y";';
    expect(declarations(code).get("A")).toBe('const A = "x";');
  });

  it("finds every declaration, so nothing is silently skipped", () => {
    // Guards the guard: an empty map would make the report treat every route as
    // having no wrapper, which is the alarming direction rather than the quiet
    // one — but it would still be wrong.
    const code = [
      "const A = 1;",
      "function b() { return 2; }",
      "export const c = () => 3;",
      "export async function d() { return 4; }",
    ].join("\n");
    expect([...declarations(code).keys()]).toEqual(["A", "b", "c", "d"]);
  });

  it("a brace inside a string or template literal is text, not a block", () => {
    // Route files are full of these — error messages, SQL fragments, template
    // URLs. Counting one as a block open ends the declaration in the wrong
    // place, and the direction depends on which brace it lands on.
    const code = [
      'const MSG = "expected { not }";',
      "const TPL = `a ${x} b {`;",
      'adminRoutes.post("/z", async (c) => {',
      "  await writeAuditLog(c, {});",
      "});",
    ].join("\n");
    const decls = declarations(code);
    expect(decls.get("MSG")).toBe('const MSG = "expected { not }";');
    expect(decls.get("MSG")).not.toContain("writeAuditLog");
    expect(decls.get("TPL")).not.toContain("writeAuditLog");
  });
});
