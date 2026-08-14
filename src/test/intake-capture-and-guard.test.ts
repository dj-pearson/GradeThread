import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2546. FlipDesk intake had no photo field, so cataloguing an item on the
// web meant saving it, finding it again and opening it - while the phone app
// has shot photos at intake all along. Cancel and Back abandoned a filled form
// in silence, measurements could not be entered even though "measured" is a
// pipeline status, and "required" was an asterisk typed into a label.

const INTAKE = "src/pages/flipdesk/intake.tsx";
const UPLOADER = "src/components/flipdesk/photo-uploader.tsx";
const CORE = "src/lib/item-photo-upload.ts";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("photos can be taken at intake (US-2546 AC2)", () => {
  it("the form stages photos", () => {
    const src = read(INTAKE);
    expect(src).toContain("<IntakePhotoStager");
    expect(src).toContain("stagedPhotos");
  });

  it("a phone opens the camera, a desktop opens the picker", () => {
    const src = read("src/components/flipdesk/intake-photo-stager.tsx");
    expect(src).toContain('capture="environment"');
    expect(src).toContain("multiple");
  });

  it("it uploads through the SAME core the item page uses", () => {
    // Two upload paths would mean two EXIF-orientation stories, two thumbnail
    // sizes and two storage path formats, with one of them getting fixed.
    const intake = read(INTAKE);
    const uploader = read(UPLOADER);
    expect(intake).toContain('from "@/lib/item-photo-upload"');
    expect(uploader).toContain('from "@/lib/item-photo-upload"');
    expect(intake).toContain("uploadItemPhoto({");
  });

  it("the core still writes an owner-scoped storage path", () => {
    // Per-user-folder RLS on item-photos is keyed on the first path segment,
    // and it must be the WORKSPACE owner, not the acting user.
    const core = read(CORE);
    expect(core).toContain("${ownerFolder}/${itemId}/");
    expect(read(INTAKE)).toContain("ownerFolder: workspaceOwnerId");
  });

  it("a failed photo does not read as a failed save", () => {
    // The item row already exists at that point. Reporting "save failed" would
    // send the seller to catalogue it a second time.
    const src = read(INTAKE);
    expect(src).toMatch(/didn't upload\. Add them from the item page/);
  });
});

describe("a filled form warns before it is abandoned (US-2546 AC3)", () => {
  it("the page is guarded", () => {
    const src = read(INTAKE);
    expect(src).toContain("useNavigationGuard(dirty)");
    expect(src).toContain("open={guard.blocked}");
  });

  it("the guard is narrow enough to be believed", () => {
    // A dialog that fires on an untouched form is a dialog people learn to
    // click through, which is how a guard stops working.
    const src = read(INTAKE);
    expect(src).toMatch(/const dirty =\s*\n?\s*!saving &&/);
    expect(src).toContain("v !== INITIAL[k as keyof FormState]");
  });

  it("it names the photos, which are the part that cannot be recovered", () => {
    const src = read(INTAKE);
    expect(src).toMatch(/would have to be taken again/);
  });
});

describe("measurements can be entered at intake (US-2546 AC4)", () => {
  it("the shared MeasurementForm is mounted", () => {
    const src = read(INTAKE);
    expect(src).toContain("<MeasurementForm");
    expect(src).toContain('from "@/components/flipdesk/measurement-form"');
  });

  it("and they are actually written to the row", () => {
    // Mounting the form without persisting it would be worse than not having
    // it: the seller types numbers that silently vanish.
    const src = read(INTAKE);
    expect(src).toMatch(/measurements:\s*\n?\s*Object\.keys\(measurements\)\.length > 0/);
  });

  it("staged work is cleared by Save & Add another", () => {
    // Otherwise the next item in the batch inherits the last one's photos and
    // measurements, which is a data-integrity bug, not a UI one.
    const src = read(INTAKE);
    const resets = src.match(/setStagedPhotos\(\[\]\);/g) ?? [];
    expect(resets.length, "both reset paths must clear it").toBeGreaterThanOrEqual(2);
    const mResets = src.match(/setMeasurements\(\{\}\);/g) ?? [];
    expect(mResets.length).toBeGreaterThanOrEqual(2);
  });
});

describe("required is an attribute, not a character (US-2546 AC5)", () => {
  it("the title field carries required", () => {
    const src = read(INTAKE);
    expect(src, 'the label still reads "Title *"').not.toContain('label="Title *"');
    expect(src).toMatch(/label="Title"\s*\n\s*required/);
  });

  it("Field sets the real attribute and hides the decorative asterisk", () => {
    // An asterisk in label TEXT is announced as the word "star" and carries no
    // constraint. aria-hidden on the mark plus a real `required` is what a
    // screen reader reports.
    const src = read(INTAKE);
    expect(src).toContain("required={required}");
    expect(src).toContain("aria-required={required || undefined}");
    expect(src).toMatch(/<span aria-hidden="true" className="ml-0\.5 text-destructive">/);
  });
});
