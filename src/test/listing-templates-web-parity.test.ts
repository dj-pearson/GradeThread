import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  TEMPLATE_NAME_MAX,
  nameProblem,
  normalizeInput,
  preferredTemplate,
  templateChanges,
  templateSummary,
  type ListingTemplate,
} from "@/lib/flipdesk-templates";
import { ALL_SURFACES } from "@/lib/surfaces";

// US-2877. Listing templates existed on iOS and nowhere on the web.
//
// WHAT THE STORY UNDERSTATES, and it changes what the work was: the TABLE
// (00105), the full CRUD API (/api/flipdesk/templates -- GET, POST, PUT,
// DELETE) and the iOS editor all shipped with US-674. The web already READ
// templates, in one place: a dropdown in the AutoLister bulk grid. What was
// missing was a page to make, change or delete one, and any way to reach a
// saved template from the composer.
//
// So this file guards the two things that can quietly come apart: the field
// SEMANTICS between the three clients, and the wiring that makes the page
// reachable.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Swift and TS comments both, so a scan never fires on its own prose. */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/\/?.*$/gm, "");

const WEB_LIB = "src/lib/flipdesk-templates.ts";
const PAGE = "src/pages/flipdesk/templates.tsx";
const PICKER = "src/components/flipdesk/saved-template-picker.tsx";
const EDGE_LIB = "services/edge-functions/src/lib/listing-template.ts";
const EDGE_ROUTE = "services/edge-functions/src/routes/flipdesk-templates.ts";
const SWIFT_MODEL = "ios/GradeThread/Templates/ListingTemplate.swift";

/** The DB columns the edge's NormalizedTemplate names. */
function edgeFields(): string[] {
  const src = stripComments(read(EDGE_LIB));
  const at = src.indexOf("export interface NormalizedTemplate");
  expect(at, "NormalizedTemplate is gone from the edge lib").toBeGreaterThan(-1);
  const body = src.slice(at, src.indexOf("\n}", at));
  return [...body.matchAll(/^\s{2}(\w+)[?]?:/gm)].map((m) => m[1]!);
}

/** The wire keys the web's ListingTemplate names, minus `id`. */
function webFields(): string[] {
  const src = stripComments(read(WEB_LIB));
  const at = src.indexOf("export interface ListingTemplate");
  expect(at, "the web ListingTemplate is gone").toBeGreaterThan(-1);
  const body = src.slice(at, src.indexOf("\n}", at));
  return [...body.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]!).filter((f) => f !== "id");
}

/** The wire keys iOS's CodingKeys names, minus `id`. */
function swiftFields(): string[] {
  const src = stripComments(read(SWIFT_MODEL));
  const at = src.indexOf("private enum CodingKeys");
  expect(at, "iOS CodingKeys are gone").toBeGreaterThan(-1);
  const body = src.slice(at, src.indexOf("\n    }", at));
  const out: string[] = [];
  // `case descriptionTemplate = "description_template"` and the bare
  // `case id, name` line, which uses the property names as the keys.
  for (const m of body.matchAll(/^\s*case (.+)$/gm)) {
    const line = m[1]!;
    if (line.includes("=")) {
      const quoted = line.match(/"([^"]+)"/);
      if (quoted) out.push(quoted[1]!);
    } else {
      for (const bare of line.split(",")) out.push(bare.trim());
    }
  }
  return out.filter((f) => f !== "id" && f.length > 0);
}

describe("three clients, one row shape (US-2877 AC1)", () => {
  const edge = edgeFields();
  const web = webFields();
  const swift = swiftFields();

  it("the extractors actually read something", () => {
    // A scan that finds nothing reads exactly like a clean codebase.
    expect(edge.length, "no edge fields parsed").toBeGreaterThan(8);
    expect(web.length, "no web fields parsed").toBeGreaterThan(8);
    expect(swift.length, "no Swift keys parsed").toBeGreaterThan(8);
  });

  it("the web names every field the server stores", () => {
    const missing = edge.filter((f) => !web.includes(f));
    expect(
      missing,
      "the web type is missing fields the API returns. This is exactly how " +
        "condition_description was lost: the bulk grid's private copy of this " +
        "type left it out, so a note written on iOS vanished on the web.",
    ).toEqual([]);
  });

  it("the web invents no field the server does not store", () => {
    const extra = web.filter((f) => !edge.includes(f));
    expect(extra, "the web type names fields the API never sends").toEqual([]);
  });

  it("iOS and the web agree, field for field", () => {
    expect([...web].sort()).toEqual([...swift].sort());
  });

  it("there is only ONE web copy of the row type", () => {
    // The bulk grid had its own, and it had drifted. A second interface named
    // ListingTemplate anywhere under src/ is that starting again.
    const grid = stripComments(read("src/pages/flipdesk/autolister-bulk-edit.tsx"));
    expect(
      /interface ListingTemplate\b/.test(grid),
      "autolister-bulk-edit.tsx declares its own ListingTemplate again",
    ).toBe(false);
    expect(grid).toContain("@/lib/flipdesk-templates");
  });

  it("item_specifics is one value per aspect, on all three", () => {
    // The grid typed it `Record<string, string[] | string>` and branched on
    // Array.isArray, defending against a shape `coerceSpecifics` cannot emit.
    expect(read(WEB_LIB)).toContain("item_specifics: Record<string, string>;");
    expect(stripComments(read(EDGE_LIB))).toContain(
      "item_specifics: Record<string, string>;",
    );
    expect(stripComments(read(SWIFT_MODEL))).toContain(
      "var itemSpecifics: [String: String]",
    );
  });

  it("the name cap is the server's number, not a second one", () => {
    const edgeSrc = stripComments(read(EDGE_LIB));
    const m = edgeSrc.match(/TEMPLATE_NAME_MAX = (\d+)/);
    expect(m, "the edge no longer declares TEMPLATE_NAME_MAX").not.toBeNull();
    expect(TEMPLATE_NAME_MAX).toBe(Number(m![1]));
  });
});

describe("the page can create, edit and delete (US-2877 AC1)", () => {
  const page = stripComments(read(PAGE));

  it("all four verbs are wired", () => {
    for (const fn of ["listTemplates", "createTemplate", "updateTemplate", "deleteTemplate"]) {
      expect(page, `the page never calls ${fn}`).toContain(fn);
    }
  });

  it("the edge route still offers all four", () => {
    const route = stripComments(read(EDGE_ROUTE));
    expect(route).toContain("flipdeskTemplatesRoutes.get(");
    expect(route).toContain("flipdeskTemplatesRoutes.post(");
    expect(route).toContain("flipdeskTemplatesRoutes.put(");
    expect(route).toContain("flipdeskTemplatesRoutes.delete(");
  });

  it("a delete is confirmed, and the confirm says what survives", () => {
    // Deleting a template does not touch the listings it already filled in.
    // Saying so is the difference between a confident click and a support
    // ticket.
    expect(page).toContain("useConfirm");
    expect(page).toMatch(/destructive: true/);
    expect(page).toContain("keep everything it filled in");
  });

  it("every field iOS's editor captures is on the page too", () => {
    // Field-for-field with TemplateEditorSheet. A web editor missing one is a
    // field a desktop seller can never set.
    for (const [label, marker] of [
      ["name", "tpl-name"],
      ["default flag", "tpl-default"],
      ["description boilerplate", "tpl-desc"],
      ["condition", "tpl-condition"],
      ["condition note", "tpl-cond-note"],
      ["eBay category", "tpl-cat"],
      ["shipping policy", "Shipping policy ID"],
      ["return policy", "Return policy ID"],
      ["payment policy", "Payment policy ID"],
      ["item specifics", "Add a detail"],
    ] as const) {
      expect(page, `the editor has no ${label} field`).toContain(marker);
    }
  });

  it("the condition list is the shared one", () => {
    // A hand-typed second list of eBay conditions is how a template ends up
    // holding a value eBay rejects at publish.
    expect(page).toContain('import { EBAY_CONDITION_OPTIONS } from "@/lib/constants"');
    expect(page).toMatch(/EBAY_CONDITION_OPTIONS\.map\(/);
  });
});

describe("it is reachable (US-2877 AC2)", () => {
  it("the registry places it in List & sell", () => {
    const s = ALL_SURFACES.find((x) => x.id === "listing-templates");
    expect(s, "listing-templates left the registry").toBeDefined();
    expect(s!.web).toBe("/dashboard/flipdesk/templates");
    expect(s!.nav).not.toBeNull();
    expect(s!.nav!.group).toBe("FlipDesk");
    expect(s!.nav!.subgroup).toBe("List & sell");
  });

  it("the router renders the page there", () => {
    const routes = read("src/routes/index.tsx");
    expect(routes).toContain('path: "/dashboard/flipdesk/templates"');
    expect(routes).toContain("FlipdeskTemplatesPage");
  });

  it("the composer offers saved templates", () => {
    const composer = stripComments(read("src/pages/flipdesk/composer.tsx"));
    // The RENDER, not the import. Renaming the tag to <UnusedTemplatePicker>
    // left the import line intact and a bare toContain went right past it.
    expect(composer, "the composer imports the picker and never renders it").toMatch(
      /<SavedTemplatePicker\b/,
    );
    // And it wires every field the picker can hand back -- a patch key with no
    // setter behind it is a field that silently does nothing.
    for (const setter of [
      // US-2960: the description is an array of blocks now, so the whole-string
      // patch is folded into the intro block rather than set on a textarea.
      // Same requirement, one indirection later: the key still has to land.
      "applyDescriptionText(patch.description)",
      "setEbayCondition(patch.ebayCondition)",
      "setConditionDesc(patch.conditionDescription)",
      "setLivePickedCategoryId(patch.categoryId)",
      "setShippingPolicyId(patch.shippingPolicyId)",
      "setPaymentPolicyId(patch.paymentPolicyId)",
      "setReturnPolicyId(patch.returnPolicyId)",
    ]) {
      expect(composer, `the composer ignores ${setter}`).toContain(setter);
    }
  });

  it("the picker is not confused with the garment template beside it", () => {
    // composer.tsx has an `applyTemplate()` that applies DESCRIPTION_TEMPLATES
    // -- our per-garment boilerplate. Two different things, one word. The
    // distinction is written down where somebody will hit it.
    const picker = read(PICKER);
    expect(picker).toContain("DESCRIPTION_TEMPLATES");
    expect(picker).toContain("our writing rather than the seller's");
  });
});

describe("both clients offer the same set, applied the same way (US-2877 AC3, AC4)", () => {
  it("every reader shares one query key, so an edit shows up everywhere", () => {
    // Three readers now: the page, the bulk grid, the composer. A private key
    // in any of them means a template edited on the page still reads stale in
    // the composer until a reload.
    //
    // Asserted on the USE, not the name. `toContain("TEMPLATES_QUERY_KEY")`
    // passed with the picker switched to a private key, because the import
    // line still said the word -- which is the ordinary way this kind of check
    // goes quiet.
    for (const f of [PAGE, PICKER, "src/pages/flipdesk/autolister-bulk-edit.tsx"]) {
      expect(stripComments(read(f)), `${f} does not use the shared key`).toMatch(
        /queryKey: TEMPLATES_QUERY_KEY/,
      );
    }
    const grid = stripComments(read("src/pages/flipdesk/autolister-bulk-edit.tsx"));
    expect(
      /queryKey: \["flipdesk_listing_templates"\]/.test(grid),
      "the bulk grid still hardcodes the key",
    ).toBe(false);
  });

  it("the picker offers the default first, as iOS does", () => {
    const a: ListingTemplate = { ...blank(), id: "a", name: "A" };
    const b: ListingTemplate = { ...blank(), id: "b", name: "B", is_default: true };
    expect(preferredTemplate([a, b])?.id).toBe("b");
    expect(preferredTemplate([a])?.id).toBe("a");
    expect(preferredTemplate([])).toBeNull();
  });

  it("applying fills blanks and never overwrites", () => {
    const t: ListingTemplate = {
      ...blank(),
      id: "t",
      name: "T",
      description_template: "Ships fast.",
      ebay_condition: "USED_GOOD",
    };
    const changes = templateChanges(t, { description: "Already written.", ebayCondition: "" });
    const desc = changes.find((c) => c.field === "description")!;
    const cond = changes.find((c) => c.field === "ebayCondition")!;
    expect(desc.wouldOverwrite).toBe(true);
    expect(cond.wouldOverwrite).toBe(false);
  });

  it("a blank field on the template is not a change at all", () => {
    // Otherwise "use template" would clear a field the template says nothing
    // about, which is the opposite of a preset.
    const changes = templateChanges(blank(), { description: "", ebayCondition: "" });
    expect(changes).toEqual([]);
  });

  it("the picker says what it skipped", () => {
    const picker = stripComments(read(PICKER));
    expect(picker).toContain("wouldOverwrite");
    expect(picker).toContain("Left ");
  });
});

describe("the client agrees with the server about normalization", () => {
  it("blank strings become null, not empty strings", () => {
    const out = normalizeInput({ name: "  Denim  ", description_template: "   " });
    expect(out.name).toBe("Denim");
    expect(out.description_template).toBeNull();
  });

  it("item specifics drop blank keys and blank values", () => {
    const out = normalizeInput({
      name: "x",
      item_specifics: { "  Brand  ": " Levi's ", "": "y", Colour: "   " },
    });
    expect(out.item_specifics).toEqual({ Brand: "Levi's" });
  });

  it("a nameless template is refused before it reaches the server", () => {
    expect(nameProblem("   ")).not.toBeNull();
    expect(nameProblem("x".repeat(TEMPLATE_NAME_MAX + 1))).not.toBeNull();
    expect(nameProblem("Vintage denim")).toBeNull();
  });

  it("the summary says what a template carries", () => {
    expect(templateSummary(blank())).toContain("Empty");
    const t = { ...blank(), description_template: "hi", item_specifics: { Brand: "Levi's" } };
    expect(templateSummary(t)).toContain("description");
    expect(templateSummary(t)).toContain("1 item detail");
  });
});

function blank(): ListingTemplate {
  return {
    id: "",
    name: "",
    description_template: null,
    ebay_condition: null,
    condition_description: null,
    item_specifics: {},
    ebay_category_id: null,
    return_policy_id: null,
    shipping_policy_id: null,
    payment_policy_id: null,
    is_default: false,
    sort_order: 0,
  };
}
