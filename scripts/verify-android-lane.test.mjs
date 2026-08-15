import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// US-2602: the Android lane invoked the Gradle wrapper by bare name.
//
// `run("…", "gradlew.bat :app:spotlessCheck", { cwd: androidDir })` runs through
// `shell: true`, and cmd.exe does NOT resolve a bare command name from the
// current directory. So every Gradle step in the lane died before starting,
// each in 0.0s, and the summary printed ten failed checks — which reads exactly
// like ten broken builds rather than one unresolvable path.
//
// It passed review because the POSIX form directly above it, "./gradlew", is
// already a path and works. The bug existed only on the platform the lane was
// written for, which is also the platform nobody had run it on end to end.
//
// These assertions are about the INVOCATION, not the task list. The task list
// has its own guard in the story; this file exists so the wrapper cannot go back
// to being named rather than located.

const SRC = readFileSync(resolve(process.cwd(), "scripts/verify.mjs"), "utf8");

/** The `if (on("android")) { … }` block, sliced from the source. */
function androidLane() {
  const start = SRC.indexOf('if (on("android"))');
  expect(start, "the android lane is gone or was renamed").toBeGreaterThan(-1);
  const end = SRC.indexOf("── Summary", start);
  return SRC.slice(start, end === -1 ? undefined : end);
}

describe("the Android lane can find the Gradle wrapper", () => {
  it("builds an absolute path instead of naming the wrapper", () => {
    const lane = androidLane();
    expect(
      /const gw = `"\$\{resolve\(androidDir,/.test(lane),
      "gw is no longer an absolute path built from androidDir — on Windows a " +
        "bare gradlew.bat is not resolved from cwd and every Gradle step dies " +
        "in 0.0s",
    ).toBe(true);
  });

  it("never invokes a bare wrapper name", () => {
    const lane = androidLane();
    // A bare `gradlew.bat` or `./gradlew` as the START of a command string.
    const bare = [...lane.matchAll(/run\(\s*"[^"]*",\s*`?(\.\/gradlew|gradlew\.bat)\b/g)];
    expect(
      bare.map((m) => m[1]),
      "a Gradle step is invoking the wrapper by name again",
    ).toEqual([]);
  });

  it("quotes the path, because this repo lives under Documents", () => {
    const lane = androidLane();
    expect(
      /`"\$\{resolve\(/.test(lane),
      "the wrapper path is unquoted; a checkout under a path with a space would " +
        "split into two arguments",
    ).toBe(true);
  });

  it("still runs the whole CI list, in CI's order", () => {
    // The fix is about reaching Gradle. If it also dropped a step, the lane
    // would go green by doing less — the worse outcome of the two.
    const lane = androidLane();
    const order = [
      "no-ungated-log.py",
      "no-bare-strings.py",
      "check-string-formats.py",
      "check-room-schemas.mjs",
      ":app:spotlessCheck",
      ":app:detekt",
      ":app:lintDebug",
      ":app:testDebugUnitTest",
      ":app:koverVerifyDebug",
      ":app:verifyRoborazziDebug",
      ":app:assembleDebug",
      "check-merged-manifest.mjs",
      ":app:assembleDebugAndroidTest",
      ":app:assembleRelease",
      ":app:bundleRelease",
      "abi-size-report.py",
    ].map((needle) => [needle, lane.indexOf(needle)]);

    for (const [needle, at] of order) {
      expect(at, `${needle} is missing from the android lane`).toBeGreaterThan(-1);
    }
    for (let i = 1; i < order.length; i++) {
      expect(
        Number(order[i][1]) > Number(order[i-1][1]),
        `${order[i][0]} runs before ${order[i-1][0]} — the lane no longer mirrors android-ci.yml`,
      ).toBe(true);
    }
  });
});
