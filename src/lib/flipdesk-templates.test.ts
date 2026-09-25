import { beforeEach, describe, expect, it, vi } from "vitest";

const edgeFetch = vi.fn();
vi.mock("@/lib/edge-fetch", () => ({ edgeFetch: (...a: unknown[]) => edgeFetch(...a) }));

import {
  TemplateApiError,
  addStarterTemplates,
  createTemplate,
  deleteConfirmText,
  duplicateNameProblem,
  nextSortOrder,
  saveErrorNextStep,
  specificRowProblems,
  templateChips,
  templateConditionLabel,
  type ListingTemplate,
} from "@/lib/flipdesk-templates";
import { STARTER_TEMPLATES } from "@/lib/starter-templates";

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

describe("duplicateNameProblem", () => {
  const list = [{ id: "a", name: "Denim" }, { id: "b", name: "Tees" }];
  it("matches trimmed and case-insensitive, ignoring the row being edited", () => {
    expect(duplicateNameProblem("  denim ", list, null)).toContain('"Denim"');
    expect(duplicateNameProblem("Denim", list, "a")).toBeNull();
    expect(duplicateNameProblem("Shoes", list, null)).toBeNull();
    expect(duplicateNameProblem("   ", list, null)).toBeNull();
  });
});

describe("specificRowProblems", () => {
  it("flags half-filled rows and case-insensitive duplicate names, not blank rows", () => {
    const p = specificRowProblems([
      { key: "a", name: "Brand", value: "" },
      { key: "b", name: "", value: "Levi's" },
      { key: "c", name: "", value: "  " },
      { key: "d", name: "Material", value: "Cotton" },
      { key: "e", name: "material ", value: "Denim" },
    ]);
    expect(p.get("a")).toBe("Add a value or remove this row.");
    expect(p.get("b")).toBe("Add a name or remove this row.");
    expect(p.has("c")).toBe(false);
    expect(p.has("d")).toBe(false);
    expect(p.get("e")).toContain("already a detail above");
  });
});

describe("deleteConfirmText", () => {
  const row = (id: string, name: string, is_default = false) => ({
    id,
    name,
    description_template: null,
    ebay_condition: null,
    condition_description: null,
    item_specifics: {},
    ebay_category_id: null,
    return_policy_id: null,
    shipping_policy_id: null,
    payment_policy_id: null,
    is_default,
    sort_order: 0,
  });
  it("says nothing extra for a non-default row", () => {
    expect(deleteConfirmText(row("a", "A"), [row("a", "A")])).not.toContain("default");
  });
  it("names the first remaining row, which is what preferredTemplate falls back to", () => {
    const a = row("a", "A", true);
    expect(deleteConfirmText(a, [a, row("b", "B"), row("c", "C")])).toContain('start with "B" instead');
  });
  it("says so when the default is the only template", () => {
    const a = row("a", "A", true);
    expect(deleteConfirmText(a, [a])).toContain("start with no template");
  });
});

describe("template condition labels", () => {
  const row = (ebay_condition: string | null): ListingTemplate =>
    ({
      id: "t1",
      user_id: "u1",
      name: "T",
      description_template: null,
      ebay_condition,
      condition_description: null,
      item_specifics: {},
      ebay_category_id: null,
      return_policy_id: null,
      shipping_policy_id: null,
      payment_policy_id: null,
      is_default: false,
      sort_order: 0,
      created_at: "",
      updated_at: "",
    }) as ListingTemplate;

  it("names USED_EXCELLENT the way a clothing buyer sees it", () => {
    expect(templateConditionLabel("USED_EXCELLENT")).toBe("Pre-owned - Good");
    expect(templateConditionLabel("PRE_OWNED_EXCELLENT")).toBe("Pre-owned - Excellent");
  });

  it("gives a starter's row chip the same condition the sample picker showed", () => {
    for (const s of STARTER_TEMPLATES) {
      const shown = s.details?.find((d) => d.label === "Condition")?.value;
      expect(templateChips(row(s.ebayCondition))[0]?.label).toBe(shown);
    }
  });
});
