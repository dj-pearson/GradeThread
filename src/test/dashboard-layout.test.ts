import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { layoutDocument, normalize } from "@/lib/dashboard-layout";
import {
  clearLayoutMirrors,
  layoutMirrorKey,
  readLayoutMirror,
  writeLayoutMirror,
} from "@/lib/dashboard-layout-mirror";
import { widgetsForSurface } from "@/lib/dashboard-widgets";

// DASH-3: the layout mirror is per user and cleared on sign-out, and a stored
// layout cannot put a widget on a persona that is never offered it.

const DOC = layoutDocument([{ id: "grading.queue", size: "md" }]);

beforeEach(() => {
  localStorage.clear();
});

describe("layout mirror isolation", () => {
  it("user B reads nothing user A wrote", () => {
    writeLayoutMirror("user-a", "grading", DOC);
    expect(readLayoutMirror("user-a", "grading")).toEqual(DOC);
    expect(readLayoutMirror("user-b", "grading")).toBeNull();
  });

  it("keys the mirror by user id and surface", () => {
    expect(layoutMirrorKey("u1", "flipdesk")).toBe("gt:dashboard-layout:u1:flipdesk");
  });

  it("neither reads nor writes without a user", () => {
    writeLayoutMirror(undefined, "grading", DOC);
    expect(localStorage.length).toBe(0);
    localStorage.setItem("gt:dashboard-layout:grading", JSON.stringify(DOC));
    expect(readLayoutMirror(null, "grading")).toBeNull();
  });

  it("clearLayoutMirrors removes every mirrored layout and nothing else", () => {
    writeLayoutMirror("user-a", "grading", DOC);
    writeLayoutMirror("user-b", "flipdesk", DOC);
    localStorage.setItem("gt:dashboard-layout:grading", "legacy");
    localStorage.setItem("gt:overview-view", "flipdesk");
    clearLayoutMirrors();
    expect(localStorage.getItem(layoutMirrorKey("user-a", "grading"))).toBeNull();
    expect(localStorage.getItem(layoutMirrorKey("user-b", "flipdesk"))).toBeNull();
    expect(localStorage.getItem("gt:dashboard-layout:grading")).toBeNull();
    expect(localStorage.getItem("gt:overview-view")).toBe("flipdesk");
  });

  it("sign-out clears the mirror", () => {
    const src = readFileSync("src/hooks/use-auth.ts", "utf8");
    const signedOut = src.slice(src.indexOf("// SIGNED_OUT"));
    expect(signedOut).toContain("clearLayoutMirrors();");
  });
});

describe("normalize drops widgets the persona is not offered", () => {
  const registry = widgetsForSurface("grading");
  const sellerOnly = registry.find(
    (w) => w.personas.includes("seller") && !w.personas.includes("buyer"),
  )!;

  it("has a seller-only grading widget to test with", () => {
    expect(sellerOnly).toBeTruthy();
  });

  it("drops a seller-only widget for a buyer", () => {
    const doc = layoutDocument([{ id: sellerOnly.id, size: sellerOnly.defaultSize }]);
    expect(normalize(doc, registry, "buyer")).toEqual([]);
  });

  it("keeps it for a seller", () => {
    const doc = layoutDocument([{ id: sellerOnly.id, size: sellerOnly.defaultSize }]);
    expect(normalize(doc, registry, "seller").map((e) => e.id)).toEqual([sellerOnly.id]);
  });
});
