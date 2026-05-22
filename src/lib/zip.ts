// Minimal ZIP reader for the browser. Parses the central directory and
// inflates deflate-compressed entries via the native DecompressionStream.
// Supports stored (method 0) and deflate (method 8) entries — the only
// methods normal archivers produce for image bundles.

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

// Returns the lowercased file name without any directory prefix.
export function baseName(name: string): string {
  const parts = name.split(/[\\/]/);
  return (parts[parts.length - 1] ?? name).toLowerCase();
}

export async function readZip(file: Blob): Promise<ZipEntry[]> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(buf.buffer);

  // Locate the End of Central Directory record (signature 0x06054b50),
  // scanning backwards because it ends with a variable-length comment.
  let eocd = -1;
  const minScan = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minScan; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("Not a valid ZIP file.");

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  const entries: ZipEntry[] = [];
  for (let n = 0; n < entryCount; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("Corrupt ZIP central directory.");
    }
    const method = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(
      buf.subarray(offset + 46, offset + 46 + nameLen)
    );
    offset += 46 + nameLen + extraLen + commentLen;

    // Skip directory entries and macOS resource-fork junk.
    if (name.endsWith("/") || name.startsWith("__MACOSX")) continue;

    // Read the local file header to find where the data actually starts.
    if (view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error("Corrupt ZIP local header.");
    }
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compData = buf.subarray(dataStart, dataStart + compSize);

    let data: Uint8Array;
    if (method === 0) {
      data = compData;
    } else if (method === 8) {
      data = await inflateRaw(compData);
    } else {
      throw new Error(`Unsupported ZIP compression method ${method}.`);
    }
    entries.push({ name, data });
  }
  return entries;
}
