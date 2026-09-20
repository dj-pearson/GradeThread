import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// US-3185: AutoLister's half of phone-as-camera.
//
// The rules that matter here are WIRING rules, and a render test would not
// reach them: the page is two and a half thousand lines behind an entitlement
// gate, a workspace and an IndexedDB session. What a source scan can say —
// and what would actually go wrong — is that the entry point is on the intake
// surface with the other photo sources, that the capture binds to `staging`
// rather than to a generation batch that does not exist yet, and that the
// arriving photos are split by the index the phone stamped instead of being
// dropped into one heap.

const root = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const PAGE = read("src/pages/flipdesk/autolister.tsx");
const HOOK = read("src/pages/flipdesk/autolister/use-phone-capture.tsx");
const STAGING = read("src/pages/flipdesk/autolister/phone-capture-staging.ts");
const PANELS = read("src/pages/flipdesk/autolister/upload-panels.tsx");
const DIALOG = read("src/components/flipdesk/phone-capture-dialog.tsx");

describe("AutoLister phone capture (US-3185)", () => {
  it("the entry point sits in the upload dropzone with the other photo sources", () => {
    // AC4. Not a page of its own: every one of these is the same job, and a
    // seller looking for "the other way to add photos" looks in one place.
    expect(PANELS).toMatch(/phoneCapture: AutolisterPhoneCapture \| null;/);
    expect(PANELS).toContain("Shoot with your phone");
    // Beside Google Photos, which is the surface the AC names.
    expect(PANELS.indexOf("phoneCapture &&")).toBeLessThan(PANELS.indexOf("googlePhotos &&"));
    expect(PAGE).toContain("phoneCapture={");
  });

  it("the capture binds to staging, never to a generation batch", () => {
    // The batch row is created when generation STARTS, which is after these
    // photos exist and have been grouped into items. Binding to `batch` here
    // would mean ownsTarget looking up a row that cannot be there, so every
    // capture would 404 and the button would look broken.
    expect(HOOK).toMatch(/targetKind="staging"/);
    expect(HOOK).not.toMatch(/targetKind="batch"/);
    // And to the seller's own AutoLister session, which is what the staged
    // photos are already filed under.
    expect(PAGE).toMatch(/useAutolisterPhoneCapture\(ownerId, sessionId\.current/);
  });

  it("arriving photos are split by the item the phone marked, not heaped", () => {
    // AC5. The whole point of the boundary control: one group per item, so
    // the existing grouping grid and generate pipeline take them unchanged.
    expect(STAGING).toContain("groupPhotosByItem");
    expect(HOOK).toContain("stageCapturedPhotos");
    expect(PAGE).toContain("setStaged((prev) => [...prev, ...add])");
    expect(PAGE).toContain("setGroups(next)");
  });

  it("the group map is a ref, and it is cleared when the code is", () => {
    // Two bugs this pins, both of which would look like the feature working.
    // A state variable would be read stale inside the poll's callback, so
    // every poll would start a new group for the same item; and a map kept
    // across sessions would fold the next bin's "Item 1" into the last one.
    expect(HOOK).toMatch(/groupIds = useRef<Map<number, string>>/);
    expect(HOOK).toMatch(/if \(!next\) groupIds\.current = new Map\(\)/);
  });

  it("the dialog hands the caller the group each photo was taken on", () => {
    // Without this the desktop has photos and no boundaries, which is exactly
    // the half-bridge the story warned about.
    expect(DIALOG).toMatch(/targetKind: CaptureTargetKind/);
    expect(DIALOG).toContain("status.itemCount");
  });
});
