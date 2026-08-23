import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2815: can a person actually REACH consumer grading on iOS?
//
// ConsumerGradeFlow has been complete and unit-tested since US-2016 and was
// presented by nothing — all 12 references to it in the repo were in its own
// test file. Its unit tests passed the entire time, which is the trap: a
// behaviour suite cannot see whether anything opens the thing it tests.
//
// So these are WIRING assertions, and each names a way of being subtly wrong
// rather than merely absent. Whether the screen LOOKS right is a question for a
// device; whether anything can open it is answerable here, and it is the
// question that was wrong for months.
//
// Swift cannot be compiled on this machine (no toolchain on Windows), so iOS CI
// remains the safety net for anything that has to build. These cover the half
// that is answerable by reading.

const VIEW = "ios/GradeThread/Grading/ConsumerGradeView.swift";
const PROGRESS = "ios/GradeThread/Grading/ConsumerGradeProgressView.swift";
const SHELL = "ios/GradeThread/ContentView.swift";

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("the entry point exists and reaches the flow", () => {
  it("the buyer menu opens the view", () => {
    const shell = read(SHELL);
    expect(shell, "nothing presents ConsumerGradeView").toContain("ConsumerGradeView()");
    expect(shell, "the row has no label").toContain('Label("Grade a garment"');
  });

  it("the view drives ConsumerGradeFlow rather than its own copy of the logic", () => {
    const view = read(VIEW);
    expect(view).toContain("ConsumerGradeFlow()");
    expect(view, "the flow is never started").toContain(
      "await flow.start(images: images, request: request)",
    );
  });
});

describe("the refusals happen BEFORE the money", () => {
  it("the required set is checked client-side", () => {
    // The route abstains when front/back/label is missing — after charging,
    // after a vision call per image, then refunding. The money comes back and
    // the AI spend does not. Checking here is the entire reason
    // PhotoGradeContract.missingRequired exists.
    const view = read(VIEW);
    expect(view).toContain("PhotoGradeContract.missingRequired(from:");
    // SCOPED TO canSubmit, not to the file. The first version of this asserted
    // the file merely CONTAINED `missing.isEmpty` and stayed green when the
    // check was deleted from the submit gate - because the same expression also
    // appears in the footer text below it. A sabotage caught that; an assertion
    // that can be satisfied by a label is not guarding the button.
    const canSubmit = view
      .substring(view.indexOf("private var canSubmit"))
      .split("}")[0];
    expect(canSubmit, "submit is not gated on the required shots").toContain(
      "missing.isEmpty",
    );
  });

  it("every no-charge state says so", () => {
    // An abstain and a credits prompt are both no-charge and both read as
    // failures. The flow's own header says this and the walk-around screen
    // learned it first.
    const progress = read(PROGRESS);
    expect(progress).toContain("You have not been charged.");
    // A parameter, not a habit: a future state that DOES follow a charge has to
    // pass true deliberately rather than inherit silence.
    expect(progress).toContain("charged: Bool");
  });

  it("the post-purchase gap is explained, not spun", () => {
    // An Apple purchase completing on the device does not mean the balance has
    // moved; the grant arrives server-side. A bare spinner there is shown to
    // someone who has just paid.
    expect(read(PROGRESS)).toContain("Purchase received");
  });
});

describe("photos take the sanctioned path", () => {
  it("compression goes through PhotoCompressor, never a raw encode", () => {
    // PhotoCompressor bakes orientation upright before encoding. The grading
    // pipeline ignores the EXIF flag, so a raw jpegData ships rotated photos to
    // a consumer known to mishandle them. ios/Scripts/no-raw-jpeg-encode.py is
    // the gate; this says the same thing where a reader of this flow will see it.
    const view = read(VIEW);
    expect(view).toContain("PhotoCompressor.compressOffMain(image)");
  });

  it("picking uses the app's own picker, not a second one", () => {
    // PhotoLibraryPicker configures PHPickerConfiguration with NO photoLibrary:
    // argument — a deliberate US-1013 privacy decision that means no library
    // permission and no "allow access to all photos" prompt. A hand-rolled
    // PhotosPicker here would have opted this screen out of that silently.
    const view = read(VIEW);
    expect(view).toContain("PhotoLibraryPicker(selectionLimit: 1)");
    expect(view, "a second picker mechanism crept back in").not.toContain("loadTransferable");
  });

  it("one photo per named slot, because the route rejects duplicate types", () => {
    const view = read(VIEW);
    expect(view).toContain("selectionLimit: 1");
    expect(view).toContain("requiredSlots");
  });
});
