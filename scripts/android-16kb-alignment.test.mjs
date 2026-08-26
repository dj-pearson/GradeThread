import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { checkAlignment, minLoadAlignment, REQUIRED_ALIGNMENT } from "../android/scripts/check-16kb-alignment.mjs";

// US-2893: Play requires 16 KB page-size support for apps targeting Android
// 15+. A 4 KB-aligned .so installs and then fails to load, surfacing as a
// crash in whatever feature touched it first — here the barcode scanner or the
// tag OCR, both ML Kit.
//
// The app compiles NONE of these libraries. Every .so arrives prebuilt from a
// dependency, so the alignment is a property the app inherits silently and can
// lose silently on any bump. That is what these pin.

const root = resolve(import.meta.dirname, "..");
const script = resolve(root, "android/scripts/check-16kb-alignment.mjs");

const PT_LOAD = 1;

/** A minimal ELF64 image with one PT_LOAD segment at `align`. */
function elf(align, { elfClass = 2, type = PT_LOAD } = {}) {
  const PHOFF = 64;
  const b = Buffer.alloc(PHOFF + 56);
  b.writeUInt32BE(0x7f454c46, 0);
  b[4] = elfClass;
  b.writeBigUInt64LE(BigInt(PHOFF), 0x20);
  b.writeUInt16LE(56, 0x36);
  b.writeUInt16LE(1, 0x38);
  b.writeUInt32LE(type, PHOFF);
  b.writeBigUInt64LE(BigInt(align), PHOFF + 48);
  return b;
}

/** A stored-entry zip, so the real central-directory reader is exercised. */
function zipOf(files) {
  const locals = []; const central = []; let offset = 0;
  for (const [name, content] of files) {
    const n = Buffer.from(name, "utf8");
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt32LE(content.length, 18);
    lh.writeUInt32LE(content.length, 22);
    lh.writeUInt16LE(n.length, 26);
    locals.push(lh, n, content);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt32LE(content.length, 20);
    ch.writeUInt32LE(content.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, n);
    offset += lh.length + n.length + content.length;
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

describe("16 KB alignment: reading p_align", () => {
  it("accepts exactly 16 KB", () => {
    expect(minLoadAlignment(elf(16384))).toBe(REQUIRED_ALIGNMENT);
  });

  it("accepts more than 16 KB", () => {
    // 64 KB appears on some toolchains; larger is compatible, not a failure.
    expect(minLoadAlignment(elf(65536))).toBeGreaterThan(REQUIRED_ALIGNMENT);
  });

  it("reports 4 KB as 4096 rather than passing it", () => {
    // The exact defect. A checker that returned the requirement instead of the
    // measured value would pass every library forever.
    expect(minLoadAlignment(elf(4096))).toBe(4096);
  });

  it("takes the SMALLEST PT_LOAD alignment, not the first", () => {
    // A library with one aligned and one misaligned segment cannot be mapped.
    // Reading only the first segment would call that library fine.
    const PHOFF = 64;
    const b = Buffer.alloc(PHOFF + 112);
    b.writeUInt32BE(0x7f454c46, 0);
    b[4] = 2;
    b.writeBigUInt64LE(BigInt(PHOFF), 0x20);
    b.writeUInt16LE(56, 0x36);
    b.writeUInt16LE(2, 0x38);
    b.writeUInt32LE(PT_LOAD, PHOFF);
    b.writeBigUInt64LE(16384n, PHOFF + 48);
    b.writeUInt32LE(PT_LOAD, PHOFF + 56);
    b.writeBigUInt64LE(4096n, PHOFF + 56 + 48);
    expect(minLoadAlignment(b)).toBe(4096);
  });

  it("ignores segments that are not PT_LOAD", () => {
    // Only PT_LOAD segments are mapped by the loader, so only their alignment
    // constrains the page size.
    expect(minLoadAlignment(elf(4096, { type: 4 }))).toBeNull();
  });

  it("returns null for a 32-bit image instead of a number", () => {
    expect(minLoadAlignment(elf(4096, { elfClass: 1 }))).toBeNull();
  });

  it("throws on something that is not an ELF at all", () => {
    expect(() => minLoadAlignment(Buffer.alloc(64))).toThrow();
  });
});

describe("16 KB alignment: which libraries are judged", () => {
  const artifact = () => zipOf([
    ["base/lib/arm64-v8a/libgood.so", elf(16384)],
    ["base/lib/arm64-v8a/libbad.so", elf(4096)],
    ["base/lib/x86_64/libgood.so", elf(16384)],
    ["base/lib/armeabi-v7a/libold.so", elf(4096, { elfClass: 1 })],
  ]);

  it("fails a 4 KB arm64 library", () => {
    expect(checkAlignment(artifact()).failures.some((f) => f.name.endsWith("libbad.so"))).toBe(true);
  });

  it("skips 32-bit ABIs rather than failing them", () => {
    // armeabi-v7a is exempt: 16 KB pages are a 64-bit concern. Failing it
    // would make the gate unpassable for a build that is entirely correct.
    const { failures, skipped } = checkAlignment(artifact());
    expect(skipped.some((s) => s.abi === "armeabi-v7a")).toBe(true);
    expect(failures.some((f) => f.abi === "armeabi-v7a")).toBe(false);
  });

  it("judges x86_64, which is 64-bit and is what the emulator runs", () => {
    expect(checkAlignment(artifact()).ok.some((o) => o.abi === "x86_64")).toBe(true);
  });

  it("names the ABI on every failure, so the report says which slice is broken", () => {
    expect(checkAlignment(artifact()).failures.every((f) => f.abi)).toBe(true);
  });

  it("fails an artifact with no native libraries at all", () => {
    // Every shipped build carries ML Kit. Zero .so entries means this is not
    // the artifact we think it is, and calling that 'all clear' is how a check
    // passes forever against the wrong file.
    expect(checkAlignment(zipOf([["base/dex/classes.dex", Buffer.from("x")]])).failures.length).toBeGreaterThan(0);
  });

  it("fails, rather than skips, a .so it cannot parse", () => {
    // "could not check it" and "checked it and it was fine" must never share
    // an exit code.
    const { failures } = checkAlignment(zipOf([["base/lib/arm64-v8a/libjunk.so", Buffer.alloc(80)]]));
    expect(failures.some((f) => f.name.endsWith("libjunk.so"))).toBe(true);
  });
});

describe("16 KB alignment: the gate is wired", () => {
  const release = readFileSync(resolve(root, ".github/workflows/android-release.yml"), "utf8");
  const ci = readFileSync(resolve(root, ".github/workflows/android-ci.yml"), "utf8");

  it("the release lane checks the bundle that ships", () => {
    expect(release).toMatch(/check-16kb-alignment\.mjs app\/build\/outputs\/bundle\/release\/app-release\.aab/);
  });

  it("CI checks the release bundle it already builds", () => {
    // Unlike the release-config check, this one needs no secrets — CI's
    // placeholder build carries the same prebuilt .so files — so it can and
    // should run on every push, where a bad dependency bump appears.
    //
    // Asserts the ARTIFACT PATH, not just the script name. A bare
    // /check-16kb-alignment\.mjs/ is also satisfied by the `--self-test` line
    // two rows above it, so deleting the real check left this green — caught
    // by sabotaging the workflow, which is the only way that class of hole
    // ever shows up.
    expect(ci).toMatch(/check-16kb-alignment\.mjs app\/build\/outputs\/bundle\/release\/app-release\.aab/);
  });

  it("both lanes self-test before trusting a result", () => {
    expect(release).toMatch(/check-16kb-alignment\.mjs --self-test/);
    expect(ci).toMatch(/check-16kb-alignment\.mjs --self-test/);
  });

  it("the self-test exits zero", () => {
    expect(() => execFileSync(process.execPath, [script, "--self-test"], { encoding: "utf8" })).not.toThrow();
  });
});
