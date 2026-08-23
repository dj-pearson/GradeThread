// US-2769 AC4: the two bundled photo-profile fallbacks may not drift apart.
//
// WHAT IS AND IS NOT GUARDED HERE.
//
// The SERVER table (services/edge-functions/src/lib/photo-profiles.ts) is the
// source of truth, served by GET /api/flipdesk/photo-profiles. Both clients
// fetch it and it always wins once loaded, so it cannot drift by construction.
//
// What CAN drift is the bundled fallback each client ships for first paint and
// offline: src/lib/photo-profiles.ts and
// ios/GradeThread/Capture/PhotoProfile.swift. Two hand-maintained copies of the
// same wording in two languages, edited in different commits, by whoever was in
// that codebase. And they HAD drifted when this test was written - web had
// "The size itself, close enough to read" against iOS's "...close enough to
// read without zooming", and dropped "in even light" from the fabric hint.
//
// THIS DELIBERATELY DOES NOT ASSERT client == server. The fallbacks are
// abbreviated on purpose: the server hint for a brand label ends "— usually a
// separate neck or waistband tag" and the clients stop at "The maker's logo or
// wordmark". Eight roles follow that pattern. Asserting equality with the
// server would fail on all eight and teach the next person to delete the test.
// What the two clients say to two sellers about the same slot is the property
// worth pinning, and it is the one that was actually broken.
//
// The required set is checked separately and harder. A fallback that disagrees
// about which slots are REQUIRED lets an item advance without a front photo,
// and the eBay visual pass (US-2764..2770) then has nothing to identify from -
// that is a wrong result, not a suboptimal hint.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  missingRequiredRoles,
  type PhotoProfile,
} from "@/lib/photo-profiles";

const root = process.cwd();

interface Role {
  type: string;
  role: string | null;
  label: string;
  hint: string;
  required: boolean;
}

const key = (r: Role) => `${r.type}|${r.role ?? ""}`;

function iosRoles(): Role[] {
  const src = readFileSync(
    resolve(root, "ios/GradeThread/Capture/PhotoProfile.swift"),
    "utf8",
  );
  const re =
    /PhotoRole\(type:\s*"([^"]+)",\s*role:\s*(nil|"[^"]*"),\s*label:\s*"([^"]*)",\s*hint:\s*"([^"]*)",\s*required:\s*(true|false)/g;
  return [...src.matchAll(re)].map((m) => ({
    type: m[1]!,
    role: m[2] === "nil" ? null : m[2]!.slice(1, -1),
    label: m[3]!,
    hint: m[4]!,
    required: m[5] === "true",
  }));
}

function webRoles(): Role[] {
  const src = readFileSync(resolve(root, "src/lib/photo-profiles.ts"), "utf8");
  const re =
    /\{\s*type:\s*"([^"]+)",\s*(?:role:\s*"([^"]*)",\s*)?label:\s*"([^"]*)",\s*hint:\s*"([^"]*)",\s*required:\s*(true|false)/g;
  return [...src.matchAll(re)].map((m) => ({
    type: m[1]!,
    role: m[2] ?? null,
    label: m[3]!,
    hint: m[4]!,
    required: m[5] === "true",
  }));
}

/**
 * US-2812: the THIRD bundled fallback.
 *
 * This file was written for two clients and Android has had its own copy the
 * whole time, unguarded — so it could say anything to an Android seller and
 * nothing would go red. Found while adding a shoes fallback to all three:
 * two were updated, the web one was not, and only the web/iOS comparison
 * caught it. Android would have stayed silently different either way.
 */
function androidRoles(): Role[] {
  const src = readFileSync(
    resolve(root, "android/app/src/main/java/com/gradethread/app/capture/PhotoProfile.kt"),
    "utf8",
  );
  // PhotoRole(type, label, hint, required = b, icon = s, role = s) — role is
  // a trailing named argument and is absent on most slots.
  const re =
      /PhotoRole\(\s*"([^"]+)",\s*"([^"]*)",\s*"([^"]*)",\s*required\s*=\s*(true|false)(?:[^)]*?role\s*=\s*"([^"]*)")?/g;
  return [...src.matchAll(re)].map((m) => ({
    type: m[1]!,
    role: m[5] ?? null,
    label: m[2]!,
    hint: m[3]!,
    required: m[4] === "true",
  }));
}

const ios = iosRoles();
const web = webRoles();
const android = androidRoles();

describe("US-2769: the two bundled photo-profile fallbacks stay in step", () => {
  it("parses both fallbacks, so a rename cannot make this vacuously pass", () => {
    // Without this, a refactor that changes either literal's shape leaves the
    // regexes matching nothing and every assertion below trivially true. This
    // is the failure mode that makes source-scanning tests worthless.
    expect(ios.length, "no PhotoRole(...) parsed from PhotoProfile.swift").toBeGreaterThan(10);
    expect(web.length, "no role literals parsed from src/lib/photo-profiles.ts").toBeGreaterThan(10);
    expect(android.length, "no PhotoRole(...) parsed from PhotoProfile.kt").toBeGreaterThan(10);
    expect(ios.some((r) => r.type === "front")).toBe(true);
    expect(web.some((r) => r.type === "front")).toBe(true);
  });

  it("agrees on which slots are REQUIRED", () => {
    // The safety property. A client that does not require a front lets an item
    // reach the visual pass with nothing identifying in frame.
    const req = (rs: Role[]) => [...new Set(rs.filter((r) => r.required).map(key))].sort();
    expect(req(web), "the web and iOS fallbacks disagree about required slots").toEqual(req(ios));
    expect(req(android), "the Android fallback disagrees about required slots").toEqual(req(ios));
  });

  it("still requires a front and a back", () => {
    // Pins the CONTENT, not just the agreement - two fallbacks that both
    // dropped `front` would satisfy the test above and fail every seller.
    for (const [name, rs] of [["ios", ios], ["web", web], ["android", android]] as const) {
      const req = new Set(rs.filter((r) => r.required).map(key));
      expect(req.has("front|"), `${name} no longer requires a front photo`).toBe(true);
      expect(req.has("back|"), `${name} no longer requires a back photo`).toBe(true);
    }
  });

  it("uses the same label and hint for every slot both declare", () => {
    const byKey = (rs: Role[]) => {
      const m = new Map<string, Role>();
      for (const r of rs) if (!m.has(key(r))) m.set(key(r), r);
      return m;
    };
    const mi = byKey(ios);
    const mw = byKey(web);
    const ma = byKey(android);

    const shared = [...mw.keys()].filter((k) => mi.has(k)).sort();
    expect(shared.length, "the fallbacks share no slots at all").toBeGreaterThan(5);

    const drift: string[] = [];
    for (const k of shared) {
      const a = mi.get(k)!;
      const b = mw.get(k)!;
      if (a.label !== b.label) drift.push(`${k} label: ios=${JSON.stringify(a.label)} web=${JSON.stringify(b.label)}`);
      if (a.hint !== b.hint) drift.push(`${k} hint: ios=${JSON.stringify(a.hint)} web=${JSON.stringify(b.hint)}`);
      if (a.required !== b.required) drift.push(`${k} required: ios=${a.required} web=${b.required}`);
      // US-2812: Android was in the REQUIRED check and not this one — a
      // sabotage changing an Android hint alone stayed green until this line.
      const c = ma.get(k);
      if (c) {
        if (c.label !== a.label) drift.push(`${k} label: android=${JSON.stringify(c.label)} ios=${JSON.stringify(a.label)}`);
        if (c.hint !== a.hint) drift.push(`${k} hint: android=${JSON.stringify(c.hint)} ios=${JSON.stringify(a.hint)}`);
      }
    }
    expect(
      drift,
      "the two clients describe the same slot differently to two sellers. " +
        "The server table wins once it loads, so this is what a seller reads on " +
        "first paint and offline — fix the copy that disagrees with the server.",
    ).toEqual([]);
  });
});

// ⚠ WHAT THIS FILE STILL CANNOT SEE (US-2812, found by sabotage)
//
// Every parser above pools EVERY PhotoRole literal in a file, regardless of
// which profile it belongs to. So a slot that appears in two profiles masks a
// change in one of them: making `front` optional in the shoes fallback alone
// leaves `front|` in the required set, because the clothing fallback still
// contributes it. A sabotage doing exactly that stayed GREEN.
//
// It also cannot see ROUTING. Deleting the line that returns SHOES_FALLBACK
// leaves the constant defined and every role literal still parsed, so the
// fallback becomes unreachable with nothing going red.
//
// Both are worth fixing by parsing per-profile rather than per-file. Left as
// a known limit rather than a silent one, because a guard whose weaknesses
// are written down is one the next person can trust exactly as far as it
// goes.

// ── The web intake surface (US-2769 AC1) ────────────────────────────────────
//
// The fallbacks above were never the whole story. src/components/flipdesk/
// intake-photo-stager.tsx carried a FIFTH copy of this vocabulary: its own
// four-entry INTAKE_TYPES list, with its own labels, no hints at all, and the
// type chosen from a dropdown AFTER the shot was taken. So the one web surface
// a seller photographs at never named the shot it wanted, while iOS has since
// US-2134. It now resolves its slots through usePhotoProfile, the same call the
// item page and the phone make.

const stager = readFileSync(
  resolve(root, "src/components/flipdesk/intake-photo-stager.tsx"),
  "utf8",
);

describe("US-2769 AC1: the web intake stager speaks the shared vocabulary", () => {
  it("reads the file it is asserting about", () => {
    // Same anti-vacuous guard as above: a rename must fail this test loudly
    // rather than turn every assertion below into a check on an empty string.
    expect(stager.length, "intake-photo-stager.tsx is missing or empty").toBeGreaterThan(1000);
    expect(stager).toContain("IntakePhotoStager");
  });

  it("resolves its slots through usePhotoProfile", () => {
    expect(stager, "the intake stager no longer reads the photo profile").toMatch(
      /usePhotoProfile\(/,
    );
  });

  it("declares no photo vocabulary of its own", () => {
    // A local list needs labels. The profile supplies them, so a `label:` here
    // means a sixth copy has been started.
    expect(
      stager.match(/label:\s*"/g) ?? [],
      "intake-photo-stager.tsx declares its own slot labels again",
    ).toEqual([]);

    // And nothing may echo a label the shared table already owns.
    const echoed = [...new Set(web.map((r) => r.label))].filter((l) =>
      stager.includes(`"${l}"`),
    );
    expect(echoed, "these slot labels are hardcoded in the intake stager").toEqual([]);
  });

  it("puts the profile's hint on screen, so the shot is named before it is taken", () => {
    // The hint is the difference between "Tag" and "The size itself, close
    // enough to read without zooming". Rendering the label alone would pass the
    // checks above and still tell the seller nothing.
    expect(stager, "the intake stager renders no hint").toMatch(/\.hint/);
  });

  it("does not re-gate the missing-shot notice on already having photos", () => {
    // The notice used to render only when photos.length > 0. The helper below
    // answers correctly for an empty set; this stops the old guard from being
    // put back in front of it in the JSX, where the helper cannot see it.
    expect(
      stager,
      "the missing-shot notice is gated on already having photos again",
    ).not.toMatch(/photos\.length > 0 &&\s*missing/);
  });

  it("retags through the one shared picker, not its own type menu", () => {
    expect(stager).toContain("PhotoTagSelect");
    expect(
      stager,
      "the intake stager builds its own photo-type menu again — use PhotoTagSelect",
    ).not.toMatch(/<SelectItem/);
  });
});

describe("US-2769 AC3: the missing-required gate", () => {
  const profile: PhotoProfile = {
    category: "clothing",
    label: "Clothing",
    roles: [
      { type: "front", label: "Front", hint: "h", required: true, icon: "shirt" },
      { type: "back", label: "Back", hint: "h", required: true, icon: "shirt" },
      { type: "tag", role: "size", label: "Size tag", hint: "h", required: false, icon: "tag" },
    ],
  };

  it("names every required slot when there are no photos at all", () => {
    // The bug this closes: the notice was gated on photos.length > 0, so the
    // seller most likely to save an item with no front - the one who has taken
    // nothing - was told nothing at all.
    expect(missingRequiredRoles(profile, []).map((r) => r.type)).toEqual([
      "front",
      "back",
    ]);
  });

  it("counts a photo by TYPE, whatever qualifier it carries", () => {
    expect(
      missingRequiredRoles(profile, [{ photoType: "front" }]).map((r) => r.type),
    ).toEqual(["back"]);
  });

  it("never asks for an optional slot", () => {
    const done = missingRequiredRoles(profile, [
      { photoType: "front" },
      { photoType: "back" },
    ]);
    expect(done).toEqual([]);
  });
});
