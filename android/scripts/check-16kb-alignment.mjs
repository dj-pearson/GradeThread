#!/usr/bin/env node
// US-2893 -- prove every 64-bit native library can load on a 16 KB-page device.
//
//   node android/scripts/check-16kb-alignment.mjs <app.aab | app.apk>
//   node android/scripts/check-16kb-alignment.mjs --self-test
//
// Google Play requires apps targeting Android 15+ to support 16 KB memory page
// sizes on 64-bit devices. A shared library whose PT_LOAD segments are aligned
// to the old 4 KB page cannot be mapped on such a device: the app installs and
// then fails to load the library, which surfaces as a crash in whatever feature
// touched it first -- here, the barcode scanner or the tag OCR.
//
// THE APP DOES NOT COMPILE ANY OF THIS CODE. Every .so in the bundle arrives
// prebuilt from a dependency: ML Kit ships the OCR pipeline (~10.5 MB on arm64)
// and the barcode scanner (~4.7 MB), Sentry ships two, CameraX and Compose ship
// small ones. Alignment is decided by whoever built them, so the fix for a
// failure here is a DEPENDENCY UPGRADE, never a Gradle flag. AGP aligns what it
// packages; it cannot re-link someone else's binary.
//
// WHAT THIS FOUND, 2026-08-25: nothing. All eight arm64-v8a libraries already
// report a 16 KB minimum PT_LOAD alignment, ML Kit's two included. The story
// that prompted this assumed the pinned versions predated the requirement and
// that assumption was simply wrong. The check still earns its place, because
// what it guards is the NEXT dependency bump: this is a property the app
// inherits silently and can lose silently, and the symptom is a crash on a
// class of device nobody here owns.

import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { entriesMatching, readEntry } from "./lib/apk-zip.mjs";

/** Play's requirement, in bytes. */
export const REQUIRED_ALIGNMENT = 16 * 1024;

// 16 KB pages are a 64-bit concern; armeabi-v7a is exempt and is checked only
// so the report can say so out loud rather than leaving a reader wondering
// whether it was forgotten.
const SIXTY_FOUR_BIT = ["arm64-v8a", "x86_64"];

const ELF_MAGIC = 0x7f454c46;
const ELFCLASS64 = 2;
const PT_LOAD = 1;

/**
 * The smallest PT_LOAD alignment in an ELF64 image, or null if there is none.
 *
 * Only PT_LOAD matters: those are the segments the loader maps, and the loader
 * requires each one's alignment to be a multiple of the page size. Other
 * segment types (PT_DYNAMIC, PT_NOTE, ...) are not mapped independently.
 */
export function minLoadAlignment(elf) {
  if (elf.length < 64 || elf.readUInt32BE(0) !== ELF_MAGIC) {
    throw new Error("not an ELF image");
  }
  if (elf[4] !== ELFCLASS64) return null; // 32-bit: exempt, nothing to report

  const phoff = Number(elf.readBigUInt64LE(0x20));
  const phentsize = elf.readUInt16LE(0x36);
  const phnum = elf.readUInt16LE(0x38);

  let min = null;
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    if (o + 56 > elf.length) break;
    if (elf.readUInt32LE(o) !== PT_LOAD) continue;
    const align = Number(elf.readBigUInt64LE(o + 48)); // p_align
    min = min === null ? align : Math.min(min, align);
  }
  return min;
}

const abiOf = (name) => name.split("/").find((s) => /^(armeabi-v7a|arm64-v8a|x86_64|x86)$/.test(s)) ?? "?";

export function checkAlignment(buf) {
  const libs = entriesMatching(buf, /\.so$/);
  const failures = [];
  const ok = [];
  const skipped = [];

  for (const e of libs) {
    const abi = abiOf(e.name);
    if (!SIXTY_FOUR_BIT.includes(abi)) {
      skipped.push({ name: e.name, abi, why: "32-bit ABI -- 16 KB pages do not apply" });
      continue;
    }
    let align;
    try {
      align = minLoadAlignment(readEntry(buf, e));
    } catch (err) {
      // An unreadable .so is a FAILURE, not a skip. "Could not check it" and
      // "checked it and it was fine" must never produce the same exit code.
      failures.push({ name: e.name, abi, align: null, why: `could not read as ELF: ${err.message}` });
      continue;
    }
    if (align === null) {
      failures.push({ name: e.name, abi, align: null, why: "no PT_LOAD segments, or not ELF64" });
    } else if (align < REQUIRED_ALIGNMENT) {
      failures.push({ name: e.name, abi, align, why: `aligned to ${align / 1024} KB, needs 16 KB` });
    } else {
      ok.push({ name: e.name, abi, align });
    }
  }

  if (!libs.length) {
    // Every shipped build carries ML Kit. Zero .so entries means the artifact
    // was not what we thought, and reporting that as "all clear" is how a check
    // ends up passing forever against the wrong file.
    failures.push({ name: "(none)", abi: "-", align: null, why: "no .so entries found -- is this the right artifact?" });
  }
  return { failures, ok, skipped };
}

// ── self-test ───────────────────────────────────────────────────────────────
//
// Synthesises ELF64 images with a known p_align, because the only way to trust
// a green result is to have watched the same code go red.

/** A minimal ELF64 image with one PT_LOAD segment at `align`. */
function fakeElf(align, { elfClass = ELFCLASS64, type = PT_LOAD } = {}) {
  const PHOFF = 64;
  const buf = Buffer.alloc(PHOFF + 56);
  buf.writeUInt32BE(ELF_MAGIC, 0);
  buf[4] = elfClass;
  buf.writeBigUInt64LE(BigInt(PHOFF), 0x20);
  buf.writeUInt16LE(56, 0x36); // e_phentsize
  buf.writeUInt16LE(1, 0x38); // e_phnum
  buf.writeUInt32LE(type, PHOFF);
  buf.writeBigUInt64LE(BigInt(align), PHOFF + 48);
  return buf;
}

function selfTest() {
  const cases = [];
  const check = (label, cond) => cases.push([label, cond]);

  check("16 KB is accepted", minLoadAlignment(fakeElf(16384)) === 16384);
  check("64 KB is accepted (larger is fine)", minLoadAlignment(fakeElf(65536)) === 65536);
  // The exact defect this exists for.
  check("4 KB is reported as 4096, not silently passed", minLoadAlignment(fakeElf(4096)) === 4096);
  check("4 KB is below the requirement", minLoadAlignment(fakeElf(4096)) < REQUIRED_ALIGNMENT);
  check("32-bit returns null rather than a number", minLoadAlignment(fakeElf(4096, { elfClass: 1 })) === null);
  check("a non-PT_LOAD segment is ignored", minLoadAlignment(fakeElf(4096, { type: 4 })) === null);
  check("a non-ELF buffer throws", (() => {
    try { minLoadAlignment(Buffer.alloc(64)); return false; } catch { return true; }
  })());

  // And the whole path, through a real zip, so the plumbing is covered too.
  const zip = zipOf([
    ["base/lib/arm64-v8a/libgood.so", fakeElf(16384)],
    ["base/lib/arm64-v8a/libbad.so", fakeElf(4096)],
    ["base/lib/armeabi-v7a/libold.so", fakeElf(4096, { elfClass: 1 })],
  ]);
  const r = checkAlignment(zip);
  check("the 4 KB arm64 lib fails", r.failures.some((f) => f.name.endsWith("libbad.so")));
  check("the 16 KB arm64 lib passes", r.ok.some((o) => o.name.endsWith("libgood.so")));
  check("the 32-bit lib is skipped, not failed", r.skipped.some((s) => s.name.endsWith("libold.so")));
  check("a failure names the ABI", r.failures.every((f) => f.abi));

  // An artifact with no libraries must fail, not pass vacuously.
  check("an artifact with no .so fails", checkAlignment(zipOf([["base/dex/classes.dex", Buffer.from("x")]])).failures.length > 0);

  const failed = cases.filter(([, pass]) => !pass);
  for (const [label, pass] of cases) console.log(`  ${pass ? "ok  " : "FAIL"} ${label}`);
  if (failed.length) {
    console.error(`\ncheck-16kb-alignment: SELF-TEST FAILED (${failed.length}/${cases.length})`);
    process.exit(1);
  }
  console.log(`check-16kb-alignment: self-test OK (${cases.length} cases)`);
}

/** A stored (uncompressed) zip, so the self-test exercises the real reader. */
function zipOf(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt32LE(content.length, 18);
    lh.writeUInt32LE(content.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, content);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt32LE(content.length, 20);
    ch.writeUInt32LE(content.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + content.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// ── entry point ─────────────────────────────────────────────────────────────
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) main();

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) {
    selfTest();
    process.exit(0);
  }

  const artifact = args[0];
  if (!artifact) {
    console.error("usage: check-16kb-alignment.mjs <app.aab | app.apk> | --self-test");
    process.exit(1);
  }
  if (!existsSync(artifact)) {
    console.error(`check-16kb-alignment: no such artifact: ${artifact}`);
    process.exit(1);
  }

  const { failures, ok, skipped } = checkAlignment(readFileSync(artifact));

  console.log(`check-16kb-alignment: ${artifact}`);
  for (const o of ok) console.log(`  ok    ${o.abi.padEnd(12)} ${o.name.split("/").pop()} (${o.align / 1024} KB)`);
  for (const s of skipped) console.log(`  --    ${s.abi.padEnd(12)} ${s.name.split("/").pop()} -- ${s.why}`);
  for (const f of failures) console.error(`  FAIL  ${f.abi.padEnd(12)} ${f.name.split("/").pop()} -- ${f.why}`);

  if (failures.length) {
    console.error(
      "\ncheck-16kb-alignment: this bundle cannot load on a 16 KB-page device, and Play " +
        "requires that support for apps targeting Android 15+.\n" +
        "The app compiles none of these libraries -- each comes prebuilt from a dependency, " +
        "so the fix is to UPGRADE the dependency that ships the named .so, not to change a " +
        "Gradle setting. If no released version is aligned, that is a submission blocker to " +
        "record with the dependency named, not to work around.",
    );
    process.exit(1);
  }
  console.log(
    `check-16kb-alignment: OK (${ok.length} 64-bit lib(s) at >=16 KB, ${skipped.length} 32-bit skipped)`,
  );
}
