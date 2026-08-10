// US-2454: the primitives, tested against the shapes that broke the copies.
//
// Every case here is a real failure from 2026-08-10, reduced to a fixture. A
// helper that only works on tidy input is the same liability as the hand-rolled
// versions it replaces, because a structural guard is trusted precisely when
// nobody is looking at it.

import { assert, assertEquals, assertThrows } from "@std/assert";
import { allCallArgs, callArgs, code, fnBody } from "./_source-scan.ts";

Deno.test("code(): a comment cannot satisfy an assertion about code", () => {
  const src = [
    "// there is no buyer_pause_until column anywhere",
    "const plan = user.buyer_plan;",
    " * buyer_pause_until is also mentioned in this block comment",
    "/* and here */",
  ].join("\n");
  const stripped = code(src);
  assert(!stripped.includes("buyer_pause_until"), stripped);
  assert(stripped.includes("user.buyer_plan"));
});

Deno.test("code(): a URL inside a template string survives", () => {
  // Stripping trailing `// …` would be tidier and would eat this. These guards
  // assert on billing links, so the URL matters more than the tidiness.
  const src = 'const cta = `${SITE_URL}/buyer/billing`; // the buyer page\nconst u = "https://gradethread.com/terms";';
  const stripped = code(src);
  assert(stripped.includes("https://gradethread.com/terms"));
  assert(stripped.includes("/buyer/billing"));
});

Deno.test("fnBody(): an inline object PARAMETER TYPE does not swallow the body", () => {
  // THE ONE THAT COST FIVE FAILING TESTS. Taking the first `{` after the name
  // lands inside the annotation, and the match closes at the end of it — so the
  // "body" is the parameter list and every assertion about the function fails
  // as though the code were missing.
  const src = [
    "async function applyChange(",
    "  user: { id: string; buyer_plan?: string | null },",
    "  sub: Sub,",
    ") {",
    "  sendEmail(user.id);",
    "  return true;",
    "}",
  ].join("\n");
  const body = fnBody(src, "async function applyChange");
  assert(body.includes("sendEmail(user.id)"), body);
  assert(body.includes("return true"), body);
  // The annotation is NOT the body.
  assert(!body.includes("buyer_plan?: string | null"), body);
});

Deno.test("fnBody(): nested braces do not end the body early", () => {
  const src = [
    "function f() {",
    "  if (x) { g(); }",
    "  const o = { a: 1 };",
    "  h();",
    "}",
    "function after() { never(); }",
  ].join("\n");
  const body = fnBody(src, "function f");
  assert(body.includes("h();"));
  assert(!body.includes("never()"), "the body ran into the next function");
});

Deno.test("fnBody(): a missing declaration is a loud error, not an empty string", () => {
  // An empty body would make every assertion below it pass vacuously — the
  // exact shape this module exists to prevent.
  assertThrows(() => fnBody("const x = 1;", "function nope"), Error, "not found");
});

Deno.test("callArgs(): the surrounding function does not leak in", () => {
  // The trap: asserting a value inside a call by searching the whole enclosing
  // function. The same expression usually appears nearby, so the assertion
  // holds while the call itself is wrong.
  const src = [
    "async function handler() {",
    "  await record({ plan: update.buyer_plan });",
    "  return json({ plan: update.buyer_plan });",
    "}",
  ].join("\n");
  const args = callArgs(src, "record");
  assertEquals(args.trim(), "{ plan: update.buyer_plan }");
  assert(!args.includes("json("), args);
});

Deno.test("callArgs(): nested calls and parens are matched, not the first close", () => {
  const src = 'send(to, { url: build(a, (b)), n: f(g(1)) })';
  const args = callArgs(src, "send");
  assert(args.includes("f(g(1))"), args);
  assert(args.endsWith("}"), args);
});

Deno.test("callArgs(): `from` scopes the search to one branch", () => {
  const src = [
    "if (buyer) {",
    "  record({ plan: 'guard' });",
    "} else {",
    "  record({ plan: 'pro' });",
    "}",
  ].join("\n");
  const second = src.indexOf("} else {");
  assertEquals(callArgs(src, "record").trim(), "{ plan: 'guard' }");
  assertEquals(callArgs(src, "record", second).trim(), "{ plan: 'pro' }");
});

Deno.test("allCallArgs(): one entry per call site", () => {
  // The shape behind "one caller per product, each naming its own" — which type
  // checking cannot catch, because a buyer path passing the seller's value is
  // the same type.
  const src = "f({ product: 'flipdesk' });\nf({ product: 'buyer' });\ng({});";
  const args = allCallArgs(src, "f");
  assertEquals(args.length, 2);
  assertEquals(
    args.map((a) => /product: '(\w+)'/.exec(a)?.[1]).sort(),
    ["buyer", "flipdesk"],
  );
});

Deno.test("allCallArgs(): no calls is an empty list, not a throw", () => {
  // Differs from callArgs on purpose: "check every call" over zero calls is a
  // legitimate (if suspicious) state, and the CALLER should assert the count.
  assertEquals(allCallArgs("const x = 1;", "f"), []);
});

Deno.test("fnBody(): a RETURN TYPE containing braces does not swallow the body", () => {
  // Found 2026-08-10 against fetchStripeSubscriptions, whose signature is
  // `): Promise<Map<string, { id: string; status: string | null }> | null> {`.
  // Taking the first `{` after the parameter list landed inside the return
  // type, and two correct assertions failed as though the code were missing.
  const src = [
    "async function f(): Promise<",
    "  Map<string, { id: string; status: string | null }> | null",
    "> {",
    "  const real = 1;",
    "  return null;",
    "}",
  ].join("\n");
  const body = fnBody(src, "async function f");
  assert(body.includes("const real = 1;"), body);
  assert(!body.includes("status: string | null }>"), "the return type leaked in");
});

Deno.test("fnBody(): a generic parameter list is not mistaken for the body", () => {
  const src = "function g<T extends { id: string }>(x: T): T {\n  return x;\n}";
  const body = fnBody(src, "function g");
  assert(body.includes("return x;"), body);
  assert(!body.includes("extends"), body);
});
