// US-3146: the shared effort helper, and the two ways it can silently be wrong.
//
// It has to be a NO-OP on models that reject `effort`, or adding it everywhere
// breaks those call sites. And its env override has to refuse a bad value
// rather than pass it through, because a typo in a Coolify variable would
// otherwise reach the API as an invalid effort and fail every call for that
// feature until somebody noticed.

import { assert, assertEquals } from "@std/assert";
import {
  type AiEffort,
  effortEnvVar,
  effortParams,
  getFeatureEffort,
  modelUsesEffort,
} from "../lib/ai-config.ts";

function withEnv(name: string, value: string | null, fn: () => void) {
  const prior = Deno.env.get(name);
  try {
    if (value === null) Deno.env.delete(name);
    else Deno.env.set(name, value);
    fn();
  } finally {
    if (prior === undefined) Deno.env.delete(name);
    else Deno.env.set(name, prior);
  }
}

Deno.test("effortEnvVar: slug to variable name", () => {
  assertEquals(effortEnvVar("tag_ocr"), "AI_EFFORT_TAG_OCR");
  assertEquals(effortEnvVar("receipt-extract"), "AI_EFFORT_RECEIPT_EXTRACT");
  assertEquals(effortEnvVar("photo_qa"), "AI_EFFORT_PHOTO_QA");
});

Deno.test("effortParams is a no-op on models that reject effort", () => {
  // THIS IS WHAT MAKES THE HELPER SAFE TO ADD EVERYWHERE. Haiku 4.5 returns an
  // error for output_config.effort, and US-2924 routed size_estimate and
  // photo_qa to it - so on those two the helper deliberately emits nothing
  // today and becomes live only if they are ever routed back.
  assertEquals(modelUsesEffort("claude-haiku-4-5-20251001"), false);
  assertEquals(effortParams("claude-haiku-4-5-20251001", "photo_qa", "low"), {});
  assertEquals(effortParams("claude-sonnet-4-6", "tag_ocr", "low"), {});

  // And it DOES emit on the models that take it.
  assertEquals(effortParams("claude-sonnet-5", "tag_ocr", "low"), {
    output_config: { effort: "low" },
  });
  assertEquals(effortParams("claude-opus-4-8", "tag_ocr", "medium"), {
    output_config: { effort: "medium" },
  });
});

Deno.test("the fallback is the call site's, until an operator overrides it", () => {
  withEnv("AI_EFFORT_TAG_OCR", null, () => {
    assertEquals(getFeatureEffort("tag_ocr", "low"), "low");
    assertEquals(getFeatureEffort("tag_ocr", "medium"), "medium");
  });
  withEnv("AI_EFFORT_TAG_OCR", "xhigh", () => {
    assertEquals(getFeatureEffort("tag_ocr", "low"), "xhigh");
    assertEquals(effortParams("claude-sonnet-5", "tag_ocr", "low"), {
      output_config: { effort: "xhigh" },
    });
  });
  // Case and whitespace are an operator typing into a web form, not an error.
  withEnv("AI_EFFORT_TAG_OCR", "  MAX  ", () => {
    assertEquals(getFeatureEffort("tag_ocr", "low"), "max");
  });
});

Deno.test("a bad override falls back rather than reaching the API", () => {
  // The failure this prevents: "lo" or "none" in a Coolify variable would go
  // out as output_config.effort and 400 every call for that feature. A bad env
  // var must not take a feature down, so it is ignored the way an unknown
  // GRADING_COMPOSITE_MODEL is ignored.
  for (const bad of ["lo", "LOWEST", "none", "0", "true", " ", "high "]) {
    withEnv("AI_EFFORT_TAG_OCR", bad, () => {
      assertEquals(
        getFeatureEffort("tag_ocr", "low"),
        bad.trim().toLowerCase() === "high" ? "high" : "low",
        `"${bad}" should not have been accepted verbatim`,
      );
    });
  }
});

Deno.test("one feature's override does not move another's", () => {
  // The whole reason this is per-feature and not a global AI_EFFORT: rolling
  // back a bad week on ONE feature must not move every other caller, which is
  // the same argument that split getSizeEstimateModel from getLightweightModel.
  withEnv("AI_EFFORT_TAG_OCR", "max", () => {
    assertEquals(getFeatureEffort("tag_ocr", "low"), "max");
    assertEquals(getFeatureEffort("photo_roles", "low"), "low");
    assertEquals(getFeatureEffort("reconcile", "low"), "low");
  });
});

Deno.test("every level the API accepts is accepted here, and only those", () => {
  const levels: AiEffort[] = ["low", "medium", "high", "xhigh", "max"];
  for (const level of levels) {
    withEnv("AI_EFFORT_TAG_OCR", level, () => {
      assertEquals(getFeatureEffort("tag_ocr", "low"), level);
    });
  }
  // Sonnet 4.5 / Haiku 4.5 have no effort at all; "off" is not a level.
  withEnv("AI_EFFORT_TAG_OCR", "off", () => {
    assertEquals(getFeatureEffort("tag_ocr", "medium"), "medium");
  });
});

Deno.test("the returned object is fresh, so a caller cannot mutate the next one", () => {
  const a = effortParams("claude-sonnet-5", "tag_ocr", "low") as {
    output_config: { effort: string };
  };
  a.output_config.effort = "max";
  const b = effortParams("claude-sonnet-5", "tag_ocr", "low") as {
    output_config: { effort: string };
  };
  assertEquals(b.output_config.effort, "low");
  assert(a !== b);
});
