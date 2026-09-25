import { beforeEach, describe, expect, it, vi } from "vitest";

const edgeFetch = vi.fn();
vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: (...a: unknown[]) => edgeFetch(...a) }));

import {
  TemplateApiError,
  addStarterTemplates,
  createTemplate,
  nextSortOrder,
  saveErrorNextStep,
} from "@/lib/flipdesk-templates";

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("a failed save carries the edge's code", () => {
  beforeEach(() => edgeFetch.mockReset());

  it("a name clash says to rename", async () => {
    edgeFetch.mockResolvedValueOnce(
      reply(409, { error: "A template with that name already exists", code: "template_name_taken" }),
    );
    const err = await createTemplate({ name: "Denim" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TemplateApiError);
    expect((err as TemplateApiError).code).toBe("template_name_taken");
    expect(saveErrorNextStep(err)).toMatch(/different one/);
  });

  it("a default clash says to reload, not to rename", async () => {
    edgeFetch.mockResolvedValueOnce(
      reply(409, {
        error: "Another template just became your default. Reload and try again.",
        code: "template_default_conflict",
      }),
    );
    const err = await createTemplate({ name: "Denim" }).catch((e: unknown) => e);
    expect((err as TemplateApiError).code).toBe("template_default_conflict");
    expect(saveErrorNextStep(err)).toMatch(/Reload/);
    expect(saveErrorNextStep(err)).not.toMatch(/name/i);
  });

  it("a plain 500 gets no name advice", async () => {
    edgeFetch.mockResolvedValueOnce(reply(500, { error: "Could not create template" }));
    const err = await createTemplate({ name: "Denim" }).catch((e: unknown) => e);
    expect((err as TemplateApiError).status).toBe(500);
    expect((err as TemplateApiError).code).toBeNull();
    expect(saveErrorNextStep(err)).toBeUndefined();
  });
});

describe("addStarterTemplates", () => {
  const starters = ["a", "b", "c"].map((id) => ({
    id,
    body: `body ${id}`,
    ebayCondition: "PRE_OWNED_EXCELLENT",
    conditionDescription: `note ${id}`,
  }));
  const picks = starters.map((s) => ({ sample: { id: s.id }, name: s.id.toUpperCase() }));

  it("keeps going after a failure and reports each pick", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("A template with that name already exists"))
      .mockResolvedValueOnce({});
    const progress: Array<[number, number]> = [];
    const r = await addStarterTemplates(picks, starters, 7, (d, t) => progress.push([d, t]), create);
    expect(create).toHaveBeenCalledTimes(3);
    expect(r).toEqual({
      total: 3,
      added: ["a", "c"],
      failed: [{ id: "b", name: "B", message: "A template with that name already exists" }],
    });
    // Distinct orders for the rows that saved, starting where it was told.
    expect(create.mock.calls.map((c) => (c[0] as { sort_order: number }).sort_order)).toEqual([7, 8, 8]);
    expect(progress[progress.length - 1]).toEqual([3, 3]);
  });
});

describe("nextSortOrder", () => {
  it("is one past the highest, and 0 for an empty list", () => {
    expect(nextSortOrder([])).toBe(0);
    expect(nextSortOrder([{ sort_order: 3 }, { sort_order: 9 }, { sort_order: 1 }])).toBe(10);
  });
});
