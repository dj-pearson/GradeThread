import { describe, expect, it } from "vitest";
import { decodeTextFile } from "@/lib/decode-text-file";

describe("decodeTextFile (IMP-13)", () => {
  it("decodes UTF-8", () => {
    expect(decodeTextFile(new TextEncoder().encode("Title\nCafé"))).toBe("Title\nCafé");
  });

  it("drops a UTF-8 BOM", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("Title")]);
    expect(decodeTextFile(bytes)).toBe("Title");
  });

  it("falls back to Windows-1252 for an Excel export", () => {
    // "Café" in Windows-1252: é is the single byte 0xE9, which is not UTF-8.
    const bytes = new Uint8Array([0x43, 0x61, 0x66, 0xe9]);
    expect(decodeTextFile(bytes)).toBe("Café");
  });

  it("decodes UTF-16 with a byte-order mark", () => {
    const le = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0xe9, 0x00]);
    expect(decodeTextFile(le)).toBe("Aé");
    const be = new Uint8Array([0xfe, 0xff, 0x00, 0x41, 0x00, 0xe9]);
    expect(decodeTextFile(be)).toBe("Aé");
  });
});
