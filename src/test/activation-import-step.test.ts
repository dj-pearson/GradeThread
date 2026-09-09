import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EMPTY_ACTIVATION_STATE,
  activationStepsFor,
  activationProgress,
} from "@/lib/activation-steps";
import { guidedStepsFor } from "@/lib/guided-path";
import type { UserUseCase } from "@/types/database";

// US-3262. The setup list never said "bring in what you already have".
//
// A reseller arriving from Vendoo, Poshmark or a spreadsheet has a closet, and
// the first instruction we gave them was "add your first item" -- three hundred
// times. The import machinery has existed since US-2518 (CSV) and US-9201
// (closet read through the extension), durable and reversible, and nothing in
// onboarding pointed at it.
//
// Two rules keep this step honest, and both are asserted here:
//   1. It completes on a COMPLETED import run, never on a click.
//   2. It can be set aside. A seller with nothing to import would otherwise
//      meet the permanently-lit card US-2883 removed on the buyer side.

const ROOT = process.cwd();
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const stripComments = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const SELLER_PERSONAS: UserUseCase[] = ["seller", "consignment"];
const OPTS = { notifications: false };

describe("the import step is on the seller list (US-3262)", () => {
  it("every seller persona gets it", () => {
    for (const persona of SELLER_PERSONAS) {
      const keys = activationStepsFor(persona, OPTS).map((s) => s.key);
      expect(keys, `${persona} cannot see the import step`).toContain("import");
    }
  });

  it("comes before 'add your first item'", () => {
    for (const persona of SELLER_PERSONAS) {
      const keys = activationStepsFor(persona, OPTS).map((s) => s.key);
      expect(
        keys.indexOf("import"),
        `${persona}: import must precede item -- a switcher's closet is not a first garment`,
      ).toBeLessThan(keys.indexOf("item"));
    }
  });

  it("is not offered to the buyer or the developer", () => {
    for (const persona of ["buyer", "developer"] as UserUseCase[]) {
      const keys = activationStepsFor(persona, OPTS).map((s) => s.key);
      expect(keys).not.toContain("import");
    }
  });
});

describe("it completes on a real run, not a click (US-3262)", () => {
  const step = activationStepsFor("seller", OPTS).find((s) => s.key === "import")!;

  it("is not done with no import runs", () => {
    expect(step.isDone(EMPTY_ACTIVATION_STATE)).toBe(false);
  });

  it("is done once a completed run exists", () => {
    expect(step.isDone({ ...EMPTY_ACTIVATION_STATE, importRunCount: 1 })).toBe(true);
  });

  it("reads flipdesk_import_runs, and only runs that finished", () => {
    // The count query is the only place the step's truth is resolved. A count
    // that included 'pending' or 'running' would tick the step the moment the
    // seller pressed the button, which is the rule this list exists to hold.
    const hook = stripComments(read("src/hooks/use-activation.ts"));
    expect(hook).toContain('head("flipdesk_import_runs")');
    expect(hook).toMatch(/flipdesk_import_runs[\s\S]{0,80}\.eq\("status", "completed"\)/);
  });
});

describe("it can be set aside (US-3262)", () => {
  it("import is skippable", () => {
    const step = activationStepsFor("seller", OPTS).find((s) => s.key === "import")!;
    expect(step.skippable).toBe(true);
  });

  it("nothing else is skippable", () => {
    // Every other step is something a seller eventually does; a skip control on
    // those would be an invitation to hide setup rather than to finish it.
    const personas: UserUseCase[] = [
      "seller",
      "consignment",
      "buyer",
      "developer",
    ];
    for (const persona of personas) {
      for (const step of activationStepsFor(persona, OPTS)) {
        if (step.key === "import") continue;
        expect(step.skippable, `${step.key} is skippable`).toBeUndefined();
      }
    }
  });

  it("the hook exposes skip, persists it per user, and Replay clears it", () => {
    const hook = stripComments(read("src/hooks/use-activation.ts"));
    expect(hook).toContain("function skipKey");
    expect(hook).toMatch(/const skip = useCallback/);
    // undismiss is Settings > Replay. It must clear the skips too, or a seller
    // who later switches from another tool has no way back to the step.
    expect(hook).toMatch(/const undismiss = useCallback\(\(\) => \{[\s\S]{0,400}removeStored\(skipKey/);
  });

  it("the checklist renders the skip control only for skippable steps", () => {
    const ui = stripComments(
      read("src/components/onboarding/activation-checklist.tsx"),
    );
    expect(ui).toMatch(/step\.skippable\s*&&/);
    expect(ui).toContain("skip(step)");
  });

  it("skipping shortens the list rather than stalling it", () => {
    // Progress is computed against whatever list the hook hands over, so a
    // filtered list reports 'n of 4' rather than parking on an undoable step.
    const withImport = activationStepsFor("seller", OPTS);
    const withoutImport = withImport.filter((s) => s.key !== "import");
    const state = {
      ...EMPTY_ACTIVATION_STATE,
      gradeCount: 1,
      itemCount: 1,
      sourceCount: 1,
    };
    expect(activationProgress(withoutImport, state).total).toBe(
      withImport.length - 1,
    );
    expect(activationProgress(withoutImport, state).firstIncomplete).toBe(
      withoutImport.findIndex((s) => s.key === "ebay"),
    );
  });
});

describe("the guided path does not gain a step (US-2873 AC5)", () => {
  it("never walks a seller through the import", () => {
    // The path is photo-to-published. Importing a closet is setup, not a step
    // in getting one garment listed, and a walkthrough that detours through it
    // is the chore US-2873 was written to avoid.
    for (const persona of [
      "seller",
      "consignment",
      "buyer",
      "developer",
      null,
    ] as (UserUseCase | null)[]) {
      const keys = guidedStepsFor(persona, OPTS).map((s) => s.key);
      expect(keys, `${persona} is walked through the import`).not.toContain(
        "import",
      );
    }
  });
});
