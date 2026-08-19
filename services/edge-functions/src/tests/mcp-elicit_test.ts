// US-9131: Multi Round-Trip Requests, so a PERSON is asked.
//
// The wire shape is checked against the SEP-2322 examples verbatim, because
// this is one of the few places where being subtly wrong produces no error at
// all: a client that does not recognise the result shape either ignores the
// prompt or reports the tool as broken, and neither says which.
//
// The behavioural half is about what each answer MEANS. "Declined" and "said
// no" are both refusals and neither is a failure — a model that retries a
// refusal has done the one thing the prompt existed to prevent.

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { CONFIRM_KEY, confirmationRequired, readConfirmation } = await import(
  "../lib/mcp-elicit.ts"
);
const { TOOLS } = await import("../lib/mcp-tools.ts");

// ---------------------------------------------------------------------------
// the wire shape (SEP-2322)
// ---------------------------------------------------------------------------

Deno.test("the result is an InputRequiredResult in the spec's exact shape", () => {
  const result = confirmationRequired("gradethread_publish_listing", "Publish now?") as {
    resultType: string;
    requestState: string;
    inputRequests: Record<string, { method: string; params: Record<string, unknown> }>;
  };

  // resultType is what tells a client to parse this as incomplete. Absent means
  // "complete", so getting this wrong makes the prompt vanish silently.
  assertEquals(result.resultType, "input_required");
  assertEquals(result.requestState, "gradethread_publish_listing");

  const request = result.inputRequests[CONFIRM_KEY];
  assert(request, "the confirmation request is not under its key");
  assertEquals(request.method, "elicitation/create");
  assertEquals(request.params.mode, "form");
  assertEquals(request.params.message, "Publish now?");

  const schema = request.params.requestedSchema as {
    type: string;
    properties: Record<string, { type: string }>;
    required: string[];
  };
  assertEquals(schema.type, "object");
  assertEquals(schema.properties.confirm.type, "boolean");
  assertEquals(schema.required, ["confirm"]);
});

Deno.test("the question is a BOOLEAN, not free text", () => {
  // A free-text answer would put the model back in the business of deciding
  // what the human meant, which is the job this hands to the human.
  const result = confirmationRequired("t", "go?") as {
    inputRequests: Record<string, { params: { requestedSchema: { properties: object } } }>;
  };
  const props = result.inputRequests[CONFIRM_KEY].params.requestedSchema.properties;
  assertEquals(Object.keys(props), ["confirm"]);
});

// ---------------------------------------------------------------------------
// reading the answer
// ---------------------------------------------------------------------------

Deno.test("no inputResponses means the question has not been asked", () => {
  assertEquals(readConfirmation(undefined, "t").state, "not_asked");
  assertEquals(readConfirmation({}, "t").state, "not_asked");
  assertEquals(readConfirmation({ inputResponses: {} }, "t").state, "not_asked");
});

Deno.test("accept with confirm true is the only thing that proceeds", () => {
  const verdict = readConfirmation({
    inputResponses: { [CONFIRM_KEY]: { action: "accept", content: { confirm: true } } },
    requestState: "t",
  }, "t");
  assertEquals(verdict.state, "accepted");
});

Deno.test("accept with confirm FALSE is a refusal, not a proceed", () => {
  // The case that matters most: the human read it and said no. Treating a
  // completed form as consent is exactly the bug this shape invites.
  const verdict = readConfirmation({
    inputResponses: { [CONFIRM_KEY]: { action: "accept", content: { confirm: false } } },
    requestState: "t",
  }, "t");
  assertEquals(verdict.state, "refused");
  assert(verdict.state === "refused" && /said no/i.test(verdict.message));
  assert(verdict.state === "refused" && /do not try again/i.test(verdict.message));
});

Deno.test("decline and cancel are refusals and say so differently", () => {
  for (const action of ["decline", "cancel"]) {
    const verdict = readConfirmation({
      inputResponses: { [CONFIRM_KEY]: { action } },
      requestState: "t",
    }, "t");
    assertEquals(verdict.state, "refused", action);
    assert(verdict.state === "refused" && /dismissed/i.test(verdict.message));
  }
});

Deno.test("a missing content object is a refusal, not an accept", () => {
  // action:"accept" with nothing in it does not say what was accepted.
  const verdict = readConfirmation({
    inputResponses: { [CONFIRM_KEY]: { action: "accept" } },
    requestState: "t",
  }, "t");
  assertEquals(verdict.state, "refused");
});

Deno.test("a response under the WRONG key is not read as an answer", () => {
  const verdict = readConfirmation({
    inputResponses: { some_other_request: { action: "accept", content: { confirm: true } } },
    requestState: "t",
  }, "t");
  assertEquals(verdict.state, "not_asked");
});

Deno.test("a mismatched requestState asks again rather than accepting", () => {
  // A response paired with a different request. The failure mode of guessing
  // wrong here is doing something nobody confirmed, so it fails toward asking.
  const verdict = readConfirmation({
    inputResponses: { [CONFIRM_KEY]: { action: "accept", content: { confirm: true } } },
    requestState: "a_different_tool",
  }, "gradethread_publish_listing");
  assertEquals(verdict.state, "not_asked");
});

Deno.test("an absent requestState still accepts, because it is optional", () => {
  // The spec makes requestState optional and this server does not need it for
  // state. Refusing without it would break a conformant client.
  const verdict = readConfirmation({
    inputResponses: { [CONFIRM_KEY]: { action: "accept", content: { confirm: true } } },
  }, "t");
  assertEquals(verdict.state, "accepted");
});

// ---------------------------------------------------------------------------
// which tools ask, and when
// ---------------------------------------------------------------------------

const ASKING = [
  "gradethread_publish_listing",
  "gradethread_grade_item",
  "gradethread_grade_batch",
  "gradethread_reprice_apply",
  "gradethread_end_listing",
  "gradethread_end_listings",
  "gradethread_relist",
];

Deno.test("every tool that spends money or touches a marketplace asks a human", () => {
  for (const name of ASKING) {
    const tool = TOOLS.find((t) => t.name === name);
    assert(tool, `${name} is not registered`);
    assert(tool.humanConfirmation, `${name} does not ask a human`);
  }
});

Deno.test("no READ tool asks a human", () => {
  // A prompt for something that changes nothing is a prompt a seller learns to
  // dismiss, and the next one is the publish.
  for (const tool of TOOLS) {
    if (tool.annotations.readOnlyHint !== true) continue;
    assertEquals(
      tool.humanConfirmation,
      undefined,
      `${tool.name} is read-only and should not interrupt anyone`,
    );
  }
});

Deno.test("a PREVIEW call asks nothing; only the acting call does", () => {
  for (const name of ASKING) {
    const tool = TOOLS.find((t) => t.name === name)!;
    // reprice_apply has no mode — it only ever applies, so it always asks.
    if (name === "gradethread_reprice_apply") {
      assert(tool.humanConfirmation!({ items: [] }), "reprice apply must always ask");
      continue;
    }
    assertEquals(
      tool.humanConfirmation!({ mode: "preview" }),
      null,
      `${name} prompts on a preview, which changes nothing`,
    );
    assert(
      tool.humanConfirmation!({ mode: "confirm" }),
      `${name} does not prompt on the acting call`,
    );
  }
});

Deno.test("a bulk question carries the COUNT", () => {
  // "Take these off sale" and "take 34 listings off sale" are different things
  // to agree to, and the count is the one part a seller can check at a glance.
  const bulkEnd = TOOLS.find((t) => t.name === "gradethread_end_listings")!;
  const question = bulkEnd.humanConfirmation!({
    mode: "confirm",
    listing_ids: ["a", "b", "c"],
  });
  assert(question && question.includes("3"), `the count is missing: ${question}`);

  const batch = TOOLS.find((t) => t.name === "gradethread_grade_batch")!;
  const gradeQ = batch.humanConfirmation!({ mode: "confirm", item_ids: ["a", "b"] });
  assert(gradeQ && gradeQ.includes("2"), `the count is missing: ${gradeQ}`);
});

// ---------------------------------------------------------------------------
// where the dispatcher puts it
// ---------------------------------------------------------------------------

Deno.test("the prompt is MODERN-only and sits between the gates and the handler", async () => {
  // Three properties, and each one is a different bug if it moves:
  //
  //   • modern only — a legacy client reads an InputRequiredResult as a
  //     malformed result and the tool looks broken rather than gated.
  //   • after the gates — there is no point asking a person to approve
  //     something the plan, the scope or the budget was going to refuse.
  //   • before the handler — asking after the publish is not asking.
  //
  // A source guard because reaching this branch needs an authenticated tenant
  // and a plan the gate accepts; the round trip itself is exercised against a
  // live stack, and the reading of the answer is unit-tested above.
  const src = await Deno.readTextFile(new URL("../routes/mcp.ts", import.meta.url));

  assert(
    /era === "modern" && tool\.humanConfirmation/.test(src),
    "the elicitation branch is no longer gated on the modern era",
  );

  const branch = src.indexOf("tool.humanConfirmation");
  const budget = src.indexOf("checkBudget(");
  const scope = src.indexOf("hasScope(scopes, tool.requiredScope)");
  const handler = src.indexOf("await tool.handler(");
  assert(branch > budget && branch > scope, "the prompt moved ahead of the gates");
  assert(branch < handler, "the prompt moved AFTER the handler, so it asks nothing");
});

Deno.test("every asking tool ALSO carries a confirm token", () => {
  // The two are not alternatives. Elicitation asks a person; the token proves
  // the payload did not change between the question and the action. A tool with
  // a prompt and no token could be asked "publish at $48?" and publish at $95.
  for (const name of ASKING) {
    const tool = TOOLS.find((t) => t.name === name)!;
    const props = Object.keys(tool.inputSchema.properties ?? {});
    assert(
      props.includes("confirm_token"),
      `${name} asks a human but has no confirm_token, so nothing binds the payload`,
    );
  }
});
