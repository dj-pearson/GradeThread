#!/usr/bin/env node
// US-2502: the device work Android Studio's side panels do, from a terminal.
//
// This covers Logcat, Run/Debug configurations, Device Explorer's useful half,
// and the STATIC half of Layout Inspector (a view-hierarchy dump you can read
// and diff). It does not cover the live hierarchy, the Profiler, or breakpoint
// debugging -- those need the IDE, and android/README.md says so plainly.
//
//   node android/scripts/device.mjs devices
//   node android/scripts/device.mjs avd create           create a headless AVD
//   node android/scripts/device.mjs avd start            boot it and wait
//   node android/scripts/device.mjs install [--release]  build + install
//   node android/scripts/device.mjs run                  install + launch
//   node android/scripts/device.mjs logcat [--all]       this app's logs only
//   node android/scripts/device.mjs crash                the last crash, decoded
//   node android/scripts/device.mjs screenshot [file]
//   node android/scripts/device.mjs hierarchy [file]     uiautomator view dump
//   node android/scripts/device.mjs deeplink <url>       exercise an app link
//   node android/scripts/device.mjs clear                wipe app data
//
// Every command takes --device <serial> when more than one is attached.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";

import { adbPath, androidDir, resolveSdk } from "./toolchain.mjs";

const isWindows = platform() === "win32";
// The installed package, i.e. the applicationId — not the Kotlin namespace
// (com.gradethread.app), which adb knows nothing about.
const APP_ID = "com.gradethread.myapp";
const DEBUG_APP_ID = `${APP_ID}.debug`;
const AVD_NAME = "gradethread_pixel6_api34";
// aosp-atd: the automated-test image. No Play services, no launcher, no
// background apps -- it boots in a fraction of the time a google_apis image
// takes, which is the difference between a usable local emulator and one nobody
// starts. Matches the Gradle managed device in app/build.gradle.kts.
const AVD_IMAGE = "system-images;android-34;aosp_atd;x86_64";

const sdk = resolveSdk();
if (!sdk.ok) {
  console.error("No Android SDK. Run: node android/scripts/doctor.mjs");
  process.exit(1);
}
const ADB = adbPath(sdk.sdkDir);

const argv = process.argv.slice(2);
const deviceFlag = argv.indexOf("--device");
const serial = deviceFlag > -1 ? argv[deviceFlag + 1] : null;
// Guarded on deviceFlag > -1: indexOf returns -1 when the flag is absent, and
// `i !== deviceFlag + 1` would then drop argv[0] -- i.e. the command itself.
const args = deviceFlag > -1
  ? argv.filter((_, i) => i !== deviceFlag && i !== deviceFlag + 1)
  : argv;
const cmd = args[0];
const rest = args.slice(1).filter((a) => !a.startsWith("--"));
const has = (f) => argv.includes(f);

const adbArgs = (a) => (serial ? ["-s", serial, ...a] : a);

function adb(a, opts = {}) {
  return spawnSync(ADB, adbArgs(a), { encoding: "utf8", ...opts });
}
function adbOut(a) {
  const r = adb(a);
  return (r.stdout ?? "").trim();
}
function adbInherit(a) {
  return spawnSync(ADB, adbArgs(a), { stdio: "inherit" }).status ?? 1;
}

/**
 * Blocking sleep with no shell involved. `timeout /t` on Windows needs a
 * console and fails outright when stdin is redirected -- which is how this
 * script runs from npm.
 */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function requireDevice() {
  const lines = adbOut(["devices"]).split(/\r?\n/).slice(1).filter((l) => /\tdevice$/.test(l));
  if (!lines.length) {
    console.error(
      "No device attached.\n" +
        "  Physical: enable USB debugging, then re-plug.\n" +
        "  Emulator: node android/scripts/device.mjs avd start\n" +
        "  Just running tests? `./gradlew pixel6api34DebugAndroidTest` needs no device at all.",
    );
    process.exit(1);
  }
  if (lines.length > 1 && !serial) {
    console.error(`More than one device attached; pass --device <serial>:\n${lines.join("\n")}`);
    process.exit(1);
  }
}

/** The installed package, preferring the debug build. */
function targetPackage() {
  const installed = adbOut(["shell", "pm", "list", "packages", APP_ID]);
  if (installed.includes(`package:${DEBUG_APP_ID}`)) return DEBUG_APP_ID;
  if (installed.includes(`package:${APP_ID}`)) return APP_ID;
  console.error(`Neither ${DEBUG_APP_ID} nor ${APP_ID} is installed. Run: device.mjs install`);
  process.exit(1);
}

function gradle(task) {
  const gw = join(androidDir, isWindows ? "gradlew.bat" : "gradlew");
  const r = spawnSync(gw, [task], { cwd: androidDir, stdio: "inherit", shell: isWindows });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function sdkTool(dir, name) {
  const p = join(sdk.sdkDir, dir, isWindows ? `${name}.bat` : name);
  return existsSync(p) ? p : join(sdk.sdkDir, dir, isWindows ? `${name}.exe` : name);
}

// ---------------------------------------------------------------------------

switch (cmd) {
  case "devices": {
    const out = adbOut(["devices", "-l"]);
    console.log(out || "adb reported nothing (is the server running?)");
    break;
  }

  case "avd": {
    const sub = rest[0] ?? "start";
    const sdkmanager = sdkTool("cmdline-tools/latest/bin", "sdkmanager");
    const avdmanager = sdkTool("cmdline-tools/latest/bin", "avdmanager");
    const emulator = sdkTool("emulator", "emulator");

    if (sub === "create") {
      if (!existsSync(sdkmanager)) {
        console.error(
          "cmdline-tools are not installed. Get them from\n" +
            "  developer.android.com/studio#command-line-tools-only\n" +
            `and unzip into ${join(sdk.sdkDir, "cmdline-tools", "latest")}`,
        );
        process.exit(1);
      }
      console.log(`Installing ${AVD_IMAGE} ...`);
      // The licence prompt is the reason this hangs when run by hand.
      const lic = spawnSync(sdkmanager, ["--licenses"], { input: "y\n".repeat(20), encoding: "utf8" });
      if (lic.status !== 0) console.log("(licence step reported an error; continuing)");
      if (spawnSync(sdkmanager, [AVD_IMAGE], { stdio: "inherit", shell: isWindows }).status !== 0) {
        process.exit(1);
      }
      const create = spawnSync(
        avdmanager,
        ["create", "avd", "-n", AVD_NAME, "-k", AVD_IMAGE, "-d", "pixel_6", "--force"],
        { input: "no\n", encoding: "utf8", stdio: ["pipe", "inherit", "inherit"], shell: isWindows },
      );
      process.exit(create.status ?? 0);
    }

    if (sub === "start") {
      console.log(`Booting ${AVD_NAME} (headless) ...`);
      const child = spawn(
        emulator,
        [
          "-avd", AVD_NAME,
          "-no-window",
          "-gpu", "swiftshader_indirect",
          "-noaudio",
          "-no-boot-anim",
          "-no-snapshot",
          // An animation left on is the single most common cause of a flaky
          // Compose assertion, so kill them at the source.
          "-camera-back", "none",
        ],
        { detached: true, stdio: "ignore" },
      );
      child.unref();
      process.stdout.write("waiting for boot ");
      const deadline = Date.now() + 5 * 60_000;
      for (;;) {
        if (Date.now() > deadline) {
          console.error("\nTimed out after 5 minutes.");
          process.exit(1);
        }
        adb(["wait-for-device"]);
        if (adbOut(["shell", "getprop", "sys.boot_completed"]) === "1") break;
        process.stdout.write(".");
        sleep(3000);
      }
      for (const [k, v] of [
        ["window_animation_scale", "0"],
        ["transition_animation_scale", "0"],
        ["animator_duration_scale", "0"],
      ]) {
        adb(["shell", "settings", "put", "global", k, v]);
      }
      console.log("\nbooted, animations off");
      break;
    }

    console.error(`unknown: avd ${sub} (create | start)`);
    process.exit(1);
    break;
  }

  case "install": {
    const release = has("--release");
    gradle(release ? ":app:assembleRelease" : ":app:assembleDebug");
    requireDevice();
    const apk = release
      ? join(androidDir, "app/build/outputs/apk/release/app-release.apk")
      : join(androidDir, "app/build/outputs/apk/debug/app-debug.apk");
    if (!existsSync(apk)) {
      console.error(`No APK at ${apk}`);
      process.exit(1);
    }
    // -r reinstall, -t allow a test-only build, -d allow a version downgrade
    // (which is what a local rebuild looks like after CI bumped the code).
    process.exit(adbInherit(["install", "-r", "-t", "-d", apk]));
    break;
  }

  case "run": {
    gradle(":app:assembleDebug");
    requireDevice();
    adbInherit(["install", "-r", "-t", "-d", join(androidDir, "app/build/outputs/apk/debug/app-debug.apk")]);
    // monkey rather than a hardcoded component: the launcher activity can move
    // and this resolves it from the manifest the device actually has.
    process.exit(
      adbInherit(["shell", "monkey", "-p", DEBUG_APP_ID, "-c", "android.intent.category.LAUNCHER", "1"]),
    );
    break;
  }

  case "logcat": {
    requireDevice();
    if (has("--all")) {
      spawnSync(ADB, adbArgs(["logcat"]), { stdio: "inherit" });
      break;
    }
    const pkg = targetPackage();
    const pid = adbOut(["shell", "pidof", pkg]);
    if (!pid) {
      console.error(`${pkg} is not running. Start it first: device.mjs run`);
      process.exit(1);
    }
    console.log(`--- logcat for ${pkg} (pid ${pid}); --all for everything ---`);
    spawnSync(ADB, adbArgs(["logcat", `--pid=${pid.split(/\s+/)[0]}`]), { stdio: "inherit" });
    break;
  }

  case "crash": {
    requireDevice();
    // The crash buffer survives the process, which is the point: by the time
    // you notice the app died, its pid is gone and a --pid filter finds nothing.
    const out = adbOut(["logcat", "-b", "crash", "-d", "-t", "300"]);
    if (!out.trim()) {
      console.log("crash buffer is empty");
      break;
    }
    console.log(out);
    console.log(
      "\nA release stack trace is obfuscated. Decode it with the R8 mapping:\n" +
        "  android/app/build/outputs/mapping/release/mapping.txt\n" +
        `  ${join(sdk.sdkDir, "cmdline-tools/latest/bin")}/retrace mapping.txt trace.txt`,
    );
    break;
  }

  case "screenshot": {
    requireDevice();
    const out = rest[0] ?? join(androidDir, "build", "screenshots", `device-${Date.now()}.png`);
    mkdirSync(join(out, "..").replace(/[\\/][^\\/]*$/, "") || ".", { recursive: true });
    const r = spawnSync(ADB, adbArgs(["exec-out", "screencap", "-p"]), { maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0 || !r.stdout?.length) {
      console.error("screencap failed");
      process.exit(1);
    }
    writeFileSync(out, r.stdout);
    console.log(out);
    break;
  }

  case "hierarchy": {
    requireDevice();
    const out = rest[0] ?? join(androidDir, "build", "hierarchy.xml");
    const dumped = adbOut(["shell", "uiautomator", "dump", "/sdcard/gt-dump.xml"]);
    if (!/dumped/i.test(dumped)) {
      console.error(`uiautomator dump failed: ${dumped}`);
      process.exit(1);
    }
    mkdirSync(join(out, "..").replace(/[\\/][^\\/]*$/, "") || ".", { recursive: true });
    if (adbInherit(["pull", "/sdcard/gt-dump.xml", out]) !== 0) process.exit(1);
    adb(["shell", "rm", "/sdcard/gt-dump.xml"]);
    console.log(
      `${out}\nThis is the STATIC view tree -- bounds, text, content-description, ` +
        "clickable. It diffs, which the live inspector does not. The live 3D " +
        "hierarchy still needs Android Studio.",
    );
    break;
  }

  case "deeplink": {
    requireDevice();
    const url = rest[0];
    if (!url) {
      console.error("usage: device.mjs deeplink https://gradethread.com/...");
      process.exit(1);
    }
    const pkg = targetPackage();
    process.exit(
      adbInherit(["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url, pkg]),
    );
    break;
  }

  case "clear": {
    requireDevice();
    const pkg = targetPackage();
    process.exit(adbInherit(["shell", "pm", "clear", pkg]));
    break;
  }

  default:
    console.log(
      [
        "usage: node android/scripts/device.mjs <command> [--device <serial>]",
        "",
        "  devices                 what adb can see",
        "  avd create              install the test system image + create the AVD",
        "  avd start               boot it headless, animations off",
        "  install [--release]     build and install",
        "  run                     build, install, launch",
        "  logcat [--all]          this app's log only, by pid",
        "  crash                   the crash buffer, which outlives the process",
        "  screenshot [file]",
        "  hierarchy [file]        uiautomator view dump (static Layout Inspector)",
        "  deeplink <url>          exercise an app link",
        "  clear                   wipe app data",
      ].join("\n"),
    );
    process.exit(cmd ? 1 : 0);
}
