// Read entries out of an APK or AAB, using node core only.
//
// US-2892 needed this to find `classes*.dex`; US-2893 needs it to find
// `lib/<abi>/*.so`. Shared rather than copied, because the two consumers are
// both GATES: a bug in a duplicated zip parser is a gate that stops detecting
// while continuing to report success, and finding that twice is exactly twice
// as unlikely as finding it once.
//
// No dependency on the `unzip` binary (absent on a plain Windows checkout) and
// none on an npm package. A gate someone else's dependency tree can disarm is
// not a gate.

import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/**
 * Every entry in the central directory.
 *
 * @returns {Array<{name: string, method: number, compSize: number,
 *                  uncompSize: number, localOff: number}>}
 */
export function zipEntries(buf) {
  // The EOCD is last, but a zip comment may follow it, so scan backwards for
  // the signature rather than assuming a fixed offset from the end.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip: no end-of-central-directory record");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) break;
    const nameLen = buf.readUInt16LE(p + 28);
    out.push({
      name: buf.toString("utf8", p + 46, p + 46 + nameLen),
      method: buf.readUInt16LE(p + 10),
      compSize: buf.readUInt32LE(p + 20),
      uncompSize: buf.readUInt32LE(p + 24),
      localOff: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraAndComment(buf, p);
  }
  return out;
}

const extraAndComment = (buf, p) => buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);

/** The entry's bytes, inflated if it was deflated. */
export function readEntry(buf, e) {
  // The local header repeats the name and extra fields, and its extra length
  // routinely DIFFERS from the central directory's — reading the central
  // directory's value here is the classic way to land mid-payload.
  if (buf.readUInt32LE(e.localOff) !== LOCAL_SIG) {
    throw new Error(`bad local header for ${e.name}`);
  }
  const nameLen = buf.readUInt16LE(e.localOff + 26);
  const extraLen = buf.readUInt16LE(e.localOff + 28);
  const start = e.localOff + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return raw;
  if (e.method === 8) return inflateRawSync(raw);
  throw new Error(`unsupported compression method ${e.method} for ${e.name}`);
}

/** Entries whose name matches `re`, in central-directory order. */
export const entriesMatching = (buf, re) => zipEntries(buf).filter((e) => re.test(e.name));
