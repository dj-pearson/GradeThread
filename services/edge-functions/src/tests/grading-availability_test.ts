// US-3530: an AI outage or a full grading queue refuses new grades before any
// charge, and calls fail fast while the breaker is open.
import "./_env.ts";

if (!Deno.env.get("ANTHROPIC_API_KEY") && !Deno.env.get("CLAUDE_API_KEY")) {
  Deno.env.set("ANTHROPIC_API_KEY", "unit-test-key-no-network");
}

import { assert, assertEquals, assertRejects } from "@std/assert";
import { getAnthropicClient } from "../lib/ai-config.ts";
import { AnthropicProvider } from "../lib/ai-provider-anthropic.ts";
import { _clearBreakers, CircuitOpenError } from "../lib/circuit-breaker.ts";
import {
  anthropicBreaker,
  gradingUnavailableBody,
  gradingUnavailableReason,
  maxQueuedPipelines,
} from "../lib/grading-availability.ts";

Deno.test("US-3530: open breaker and full queue are the two refusals", () => {
  assertEquals(gradingUnavailableReason("closed", 0, 24), null);
  assertEquals(
    gradingUnavailableReason("half_open", 3, 24),
    null,
    "a half-open probe is allowed",
  );
  assertEquals(gradingUnavailableReason("open", 0, 24), "ai_unavailable");
  assertEquals(gradingUnavailableReason("closed", 24, 24), "queue_full");
  assertEquals(maxQueuedPipelines(), 24);
  assert(
    gradingUnavailableBody("ai_unavailable").error.includes("not charged"),
  );
});

Deno.test("US-3530: five transient failures open the breaker; the sixth call never reaches the API", async () => {
  _clearBreakers();
  const surface = getAnthropicClient().messages as unknown as {
    create: (...a: unknown[]) => unknown;
  };
  const original = surface.create;
  let calls = 0;
  surface.create = () => {
    calls++;
    return Promise.reject(
      Object.assign(new Error("overloaded"), { status: 529 }),
    );
  };
  try {
    const provider = new AnthropicProvider();
    const req = {
      model: "claude-sonnet-5",
      maxTokens: 16,
      messages: [{
        role: "user" as const,
        content: [{ type: "text" as const, text: "hi" }],
      }],
    };
    for (let i = 0; i < 5; i++) {
      await assertRejects(() => provider.complete(req));
    }
    assertEquals(anthropicBreaker().getState(), "open");
    await assertRejects(() => provider.complete(req), CircuitOpenError);
    assertEquals(
      calls,
      5,
      "the open breaker short-circuits without calling the API",
    );
  } finally {
    surface.create = original;
    _clearBreakers();
  }
});

Deno.test("US-3530: a 400 does not trip the breaker (the API is up, it said no)", async () => {
  _clearBreakers();
  const surface = getAnthropicClient().messages as unknown as {
    create: (...a: unknown[]) => unknown;
  };
  const original = surface.create;
  surface.create = () =>
    Promise.reject(Object.assign(new Error("bad request"), { status: 400 }));
  try {
    const provider = new AnthropicProvider();
    const req = {
      model: "claude-sonnet-5",
      maxTokens: 16,
      messages: [{
        role: "user" as const,
        content: [{ type: "text" as const, text: "hi" }],
      }],
    };
    for (let i = 0; i < 8; i++) {
      await assertRejects(() => provider.complete(req));
    }
    assertEquals(anthropicBreaker().getState(), "closed");
  } finally {
    surface.create = original;
    _clearBreakers();
  }
});

Deno.test("US-3530: every submit path refuses before charging", async () => {
  const read = (p: string) => Deno.readTextFile(new URL(p, import.meta.url));
  const grade = await read("../routes/grade.ts");
  const api = await read("../routes/api-v1.ts");
  const flip = await read("../lib/grading-submit.ts");
  assert(grade.indexOf("currentGradingUnavailableReason()") > 0);
  assert(
    grade.indexOf("currentGradingUnavailableReason()") <
      grade.indexOf("runPaymentPrecedence("),
  );
  assertEquals(
    api.split("currentGradingUnavailableReason()").length - 1,
    2,
    "both api-v1 grade routes",
  );
  assert(
    flip.indexOf("currentGradingUnavailableReason()") <
      flip.indexOf("runPaymentPrecedence(\n"),
  );
});
