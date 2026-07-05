// US-1635: HTML-escape untrusted text before it is interpolated into an exported
// HTML document that gets document.write()'n into a same-origin window. Values
// like a listing's platform / category are marketplace-sourced, so un-escaped
// they are a self-XSS vector in the PDF/print export.
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
