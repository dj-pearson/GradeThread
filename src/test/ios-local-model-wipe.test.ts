import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// US-3100 — every local model has to be wiped when the tenant changes.
//
// THE BUG THIS EXISTS FOR, found while adding one: `LocalSourcer` was
// registered in the schema in US-1143 and named by NEITHER wipe. Sign out on a
// shared iPad and the next account could read the previous one's roster of the
// people who source for them — names of real people, sitting in a picker,
// with no server involved and so nothing to correct it.
//
// It is the same shape as the leak US-2496 exists to prevent, and the reason it
// survived is that nothing enforces the pairing: adding a model is one file and
// remembering the two `try ctx.delete(model:)` calls is another. A Swift test
// can assert it, but Swift only compiles in the macOS lane; this runs on every
// machine, on every `npm run verify`, in about a millisecond.
//
// THE RULE: a model in `GradeThreadSchemaV1.models` must appear in
// `clearAllLocalDataOnSignOut`. The workspace-switch wipe
// (`clearLocalTenantCache`) is deliberately narrower — it keeps the offline
// mutation queue, since a workspace switch is the same OWNER moving between
// their own workspaces — so that list is checked against an explicit exception
// rather than against everything.

const IOS = resolve(__dirname, "../../ios/GradeThread");
const SCHEMA = join(IOS, "Persistence/GradeThreadSchema.swift");
const CONTENT_VIEW = join(IOS, "ContentView.swift");
const WIPE = join(IOS, "Persistence/LocalCacheWipe.swift");
const MODELS_DIR = join(IOS, "Persistence/Models");

// US-3255 — WHERE this guard looks, and why it moved.
//
// It used to read the two `private func`s in ContentView.swift and pull the
// `try ctx.delete(model: X.self)` calls straight out of their bodies. US-3224
// then moved both bodies into LocalCacheWipe, so those functions became
// one-line delegations, the extractor found nothing, and the file went red and
// STAYED red. That is the cheap half of the cost. The expensive half is that
// for as long as it was red it was also blind: a model added to the schema and
// forgotten in the wipe — the exact leak US-3100 exists to catch — would not
// have been reported by the thing whose whole job is reporting it.
//
// So the guard now follows the delegation rather than assuming a location. It
// asserts ContentView still hands off to LocalCacheWipe (a future move is
// caught, not silently un-asserted), and reads the model list from the wipe
// itself. Every extractor below fails loudly on an empty result, because an
// extractor that finds nothing passes every assertion it is asked.

/**
 * Models that a WORKSPACE SWITCH deliberately keeps. Each needs a reason, and
 * the reason has to be about the same owner rather than about convenience.
 */
const KEPT_ON_WORKSPACE_SWITCH: Record<string, string> = {
  // The offline queue belongs to the person, not the workspace: a switch is one
  // owner moving between their own workspaces, and dropping their unflushed
  // edits would lose work they made while offline.
  LocalPendingMutation: "the queue is the same owner's across their workspaces",
};

function swiftModelsOnDisk(): string[] {
  return readdirSync(MODELS_DIR)
    .filter((name) => name.endsWith(".swift"))
    .flatMap((name) => {
      const source = readFileSync(join(MODELS_DIR, name), "utf8");
      // `@Model` immediately precedes the declaration, so this finds the models
      // and not every type that happens to live in the folder.
      return [...source.matchAll(/@Model\s+(?:public\s+)?final\s+class\s+(\w+)/g)]
        .flatMap((match) => (match[1] ? [match[1]] : []));
    })
    .sort();
}

function registeredModels(): string[] {
  const source = readFileSync(SCHEMA, "utf8");
  const start = source.indexOf("static var models:");
  expect(start, "GradeThreadSchemaV1.models not found").toBeGreaterThan(-1);
  // The array literal, not the RETURN TYPE. `[any PersistentModel.Type]` sits
  // between the two, so slicing to the first `]` after `start` reads an empty
  // block and every assertion below passes vacuously.
  const open = source.indexOf("[", source.indexOf("{", start));
  const block = source.slice(open, source.indexOf("]", open));
  expect(block, "schema model list did not parse").toContain("LocalInventoryItem");
  return [...block.matchAll(/^\s*(\w+)\.self,/gm)]
    .flatMap((match) => (match[1] ? [match[1]] : []))
    .sort();
}

/** The two wipes, and the LocalCacheWipe entry point each one delegates to. */
const WIPES = {
  clearAllLocalDataOnSignOut: "LocalCacheWipe.signOut",
  clearLocalTenantCache: "LocalCacheWipe.workspaceSwitch",
} as const;

/**
 * Assert ContentView's wipe still hands off to LocalCacheWipe, and return the
 * entry point it hands off to.
 *
 * This is the step that was missing before. Without it the guard has no way to
 * notice that the code it checks is no longer the code that runs.
 */
function delegationFor(functionName: keyof typeof WIPES): string {
  const source = readFileSync(CONTENT_VIEW, "utf8");
  const start = source.indexOf(`private func ${functionName}()`);
  expect(start, `${functionName} not found in ContentView.swift`).toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf("\n    }", start));
  const entry = WIPES[functionName];
  expect(
    body,
    `${functionName} no longer calls ${entry} — the wipe moved again, re-point this guard at wherever it went`,
  ).toContain(entry);
  return entry;
}

/**
 * The models LocalCacheWipe.deleters names, in the order it names them.
 *
 * Each entry is `("Name", { try $0.delete(model: Name.self) })`, and both
 * halves are read: a label that disagrees with the type it deletes would make
 * the diagnostics in `perform` name the wrong survivor.
 */
function wipeDeleters(): string[] {
  const source = readFileSync(WIPE, "utf8");
  const open = source.indexOf("deleters:");
  expect(open, "LocalCacheWipe.deleters not found").toBeGreaterThan(-1);
  const block = source.slice(open, source.indexOf("\n    ]", open));
  const found = [...block.matchAll(
    /\("(\w+)",\s*\{\s*try \$0\.delete\(model:\s*(\w+)\.self\)\s*\}\)/g,
  )].flatMap((m) => (m[1] && m[2] ? [[m[1], m[2]] as const] : []));
  // A guard that extracts nothing agrees with everything.
  expect(found.length, "no deleters parsed out of LocalCacheWipe").toBeGreaterThan(0);
  for (const [label, type] of found) {
    expect(label, `deleter labelled ${label} actually deletes ${type}`).toBe(type);
  }
  return found.map(([label]) => label).sort();
}

/** The models a WORKSPACE SWITCH keeps, as LocalCacheWipe itself declares them. */
function keptOnWorkspaceSwitch(): string[] {
  const source = readFileSync(WIPE, "utf8");
  const at = source.indexOf("keptOnWorkspaceSwitch:");
  expect(at, "LocalCacheWipe.keptOnWorkspaceSwitch not found").toBeGreaterThan(-1);
  const line = source.slice(at, source.indexOf("\n", at));
  return [...line.matchAll(/"(\w+)"/g)].flatMap((m) => (m[1] ? [m[1]] : [])).sort();
}

function deletedIn(functionName: keyof typeof WIPES): string[] {
  const entry = delegationFor(functionName);
  const all = wipeDeleters();
  if (entry === "LocalCacheWipe.signOut") return all;
  const kept = new Set(keptOnWorkspaceSwitch());
  return all.filter((model) => !kept.has(model)).sort();
}

describe("iOS local model wipes (US-3100)", () => {
  it("every @Model on disk is registered in the schema", () => {
    // A model missing from the schema does not fail to compile. It throws on
    // the first insert, in the seller's hands.
    expect(registeredModels()).toEqual(swiftModelsOnDisk());
  });

  it("sign-out deletes every registered model", () => {
    expect(deletedIn("clearAllLocalDataOnSignOut")).toEqual(registeredModels());
  });

  it("a workspace switch deletes everything except the named exceptions", () => {
    const expected = registeredModels()
      .filter((model) => !(model in KEPT_ON_WORKSPACE_SWITCH))
      .sort();
    expect(deletedIn("clearLocalTenantCache")).toEqual(expected);
  });

  it("the exception list here is the one LocalCacheWipe actually applies", () => {
    // Two copies of a security exception drift, and the copy that drifts is
    // the one nobody runs. This asserts they are the same list, so adding a
    // keep-on-switch in Swift without a written reason here fails.
    expect(keptOnWorkspaceSwitch()).toEqual(Object.keys(KEPT_ON_WORKSPACE_SWITCH).sort());
  });

  it("the sourcing log is local-only and still tenant-wiped", () => {
    // LocalProspectResult has no server table behind it, so nothing would
    // re-pull it and nothing would correct it. That is exactly why forgetting
    // it in a wipe would be permanent.
    const source = readFileSync(
      join(MODELS_DIR, "LocalProspectResult.swift"),
      "utf8",
    );
    expect(source).toContain("var userId: String");
    expect(deletedIn("clearAllLocalDataOnSignOut")).toContain("LocalProspectResult");
    expect(deletedIn("clearLocalTenantCache")).toContain("LocalProspectResult");
  });
});
