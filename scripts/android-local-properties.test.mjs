import { describe, expect, it } from "vitest";
import { unescapedPropertyValue } from "../android/scripts/toolchain.mjs";

// US-2602: `sdk.dir=C:/…` fails the whole Android lane, and the doctor called it OK.
//
// Android Lint's PropertyEscape rule rejects an unescaped drive colon in a
// .properties file, and `lintDebug` runs with warningsAsErrors — so one line in
// a machine-local, gitignored file turns every Android verification red. Android
// Studio writes that line, so the machine most likely to have it is the one that
// opened the project in the IDE before anyone ran the doctor.
//
// The doctor's check was "does sdk.dir point at a directory that exists?", which
// that line passes. The path was never the problem; the spelling was.
//
// These assert the PURE predicate rather than the file reader, so nothing here
// depends on how this particular machine happens to be set up.

describe("the PropertyEscape rule, as the doctor applies it", () => {
  it("flags the form Android Studio writes", () => {
    expect(unescapedPropertyValue("C:/Users/x/AppData/Local/Android/Sdk")).toBe(true);
  });

  it("accepts the escaped form Lint asks for", () => {
    expect(unescapedPropertyValue("C\\:/Users/x/AppData/Local/Android/Sdk")).toBe(false);
  });

  it("flags a raw backslash separator, escaped colon or not", () => {
    // The rule names both characters, so an escaped drive letter followed by
    // raw separators is still rejected.
    expect(unescapedPropertyValue("C\\:\\Users\\x\\Sdk")).toBe(true);
  });

  it("accepts a fully escaped Windows path", () => {
    expect(unescapedPropertyValue("C\\:\\\\Users\\\\x\\\\Sdk")).toBe(false);
  });

  it("says nothing about a POSIX path, which has neither character", () => {
    expect(unescapedPropertyValue("/home/x/Android/Sdk")).toBe(false);
  });

  it("does not mistake the escape character for the thing being escaped", () => {
    // The bug this predicate was written wrong for the first time: a lookbehind
    // rule ("a colon not preceded by a backslash") flags `C\:` — the very form
    // Lint asks for — because the backslash is itself one of the characters the
    // rule is looking for. Walking left to right is what avoids that.
    expect(unescapedPropertyValue("C\\:")).toBe(false);
    expect(unescapedPropertyValue("C:")).toBe(true);
  });

  it("treats a trailing lone backslash as unescaped", () => {
    expect(unescapedPropertyValue("C\\:\\\\Users\\")).toBe(true);
  });
});
