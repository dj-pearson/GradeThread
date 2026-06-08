// Robust client-side file download.
//
// Browsers hand a download off ASYNCHRONOUSLY after `a.click()` — and when the
// user has "Ask where to save each file" enabled, the blob isn't actually read
// until they pick a location in the Save dialog. Revoking the object URL
// synchronously (the common `URL.revokeObjectURL(url)` right after click) races
// that read, so Chrome aborts with the misleading "Failed - Insufficient
// permissions". It's intermittent and hardware-independent — retrying sometimes
// wins the race, which is exactly the reported symptom.
//
// Fix: attach the anchor to the DOM (some browsers ignore clicks on detached
// anchors) and DEFER the revoke well past any Save-dialog interaction. The held
// blob is tiny and released on the timer, so this leaks nothing meaningful.
// (FileSaver.js uses the same defer-the-revoke strategy for the same reason.)

// Long enough to outlast a user fiddling with the Save-As dialog. The object
// URL holds only the in-memory blob; releasing it after the download has surely
// been read costs nothing.
const REVOKE_DELAY_MS = 40_000;

// UTF-8 byte-order mark. Excel (and Windows generally) defaults to the system
// code page — Windows-1252 on US machines — when a CSV has no BOM, which turns
// multi-byte UTF-8 like the right single-quote U+2019 (’) into mojibake (â€™).
// Prepending the BOM makes Excel/Sheets read the file as UTF-8. The bytes are
// invisible to anything that parses CSV correctly.
const UTF8_BOM = String.fromCharCode(0xfeff);

// Builds a download-ready CSV Blob from already-joined CSV text, with the BOM
// prepended so non-ASCII characters survive the trip into Excel. Use this for
// every CSV export instead of `new Blob([text], { type: "text/csv" })`.
export function csvBlob(content: string): Blob {
  return new Blob([UTF8_BOM + content], { type: "text/csv;charset=utf-8" });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  // Defer cleanup so the browser (and a possible Save-As dialog) can read the
  // blob before its URL is revoked.
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, REVOKE_DELAY_MS);
}
