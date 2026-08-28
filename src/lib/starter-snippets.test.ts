import { describe, expect, it } from "vitest";
import { STARTER_SNIPPETS } from "@/lib/starter-snippets";
import {
  bodyProblem,
  nameProblem,
  SNIPPET_BODY_MAX,
  SNIPPET_NAME_MAX,
} from "@/lib/flipdesk-snippets";

describe("STARTER_SNIPPETS", () => {
  it("ships at least eight samples with unique ids and names", () => {
    expect(STARTER_SNIPPETS.length).toBeGreaterThanOrEqual(8);
    const ids = new Set(STARTER_SNIPPETS.map((s) => s.id));
    const names = new Set(STARTER_SNIPPETS.map((s) => s.name.toLowerCase()));
    expect(ids.size).toBe(STARTER_SNIPPETS.length);
    expect(names.size).toBe(STARTER_SNIPPETS.length);
  });

  it("every sample is savable by the editor's own validation", () => {
    for (const s of STARTER_SNIPPETS) {
      // Empty `existing`: a sample must be valid on a brand-new account, which
      // is the only account that sees the empty state this feature fixes.
      expect(nameProblem(s.name, [])).toBeNull();
      expect(bodyProblem(s.body)).toBeNull();
      expect(s.name.length).toBeLessThanOrEqual(SNIPPET_NAME_MAX);
      expect(s.body.length).toBeLessThanOrEqual(SNIPPET_BODY_MAX);
    }
  });

  it("carries no placeholder, because nothing interpolates a snippet body", () => {
    for (const s of STARTER_SNIPPETS) {
      expect(s.body).not.toMatch(/\{\{/);
    }
  });

  it("never restates the measurements or the grade (US-2965)", () => {
    // Both are their own description blocks. A snippet repeating them prints
    // the fact twice, and only the block copy follows the seller's next edit.
    for (const s of STARTER_SNIPPETS) {
      expect(s.body).not.toMatch(/measurements?|\bgrade\b/i);
    }
  });
});
