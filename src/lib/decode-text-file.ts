// IMP-13: read a spreadsheet export as text without mangling its accents.
//
// file.text() always decodes UTF-8, and Excel on Windows saves "CSV" as
// Windows-1252, so every "Café" or "Pokémon" in the file came through as a
// replacement character. Order: a UTF-16 byte-order mark wins; then strict
// UTF-8 (which throws on bytes that are not UTF-8); and only when that throws,
// Windows-1252, which can decode any byte.

export function decodeTextFile(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  }
  try {
    // A UTF-8 BOM is dropped by the decoder (ignoreBOM defaults to false).
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}
