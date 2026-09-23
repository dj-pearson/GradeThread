// Remember view choices per person and workspace. Search text, page numbers,
// saved-view loader ids and action links are intentionally not preferences.
// INV-12: `show` (the Unlisted chip) and `window` (the Sold window) are view
// choices too. The key moved to v2 with them so an old entry is not read as
// the full set.
const VIEW_PARAMS = ["mode", "sort", "tab", "size", "filter", "show", "window"] as const;
export function inventoryViewKey(userId: string, ownerId: string) {
  return `flipdesk:inventory:last-view:v2:${userId}:${ownerId}`;
}

export function inventoryViewSearch(params: URLSearchParams): string {
  const view = new URLSearchParams();
  for (const name of VIEW_PARAMS) {
    const value = params.get(name);
    if (value && value.length < 10_000) view.set(name, value);
  }
  return view.toString();
}

export function readInventoryView(key: string): string {
  try {
    // A v1 entry still holds a valid mode/sort/tab/size/filter; read it once
    // so moving the key to v2 does not reset every seller's remembered view.
    const raw = localStorage.getItem(key) ?? localStorage.getItem(key.replace(":v2:", ":v1:")) ?? "";
    return inventoryViewSearch(new URLSearchParams(raw));
  } catch { return ""; }
}

export function writeInventoryView(key: string, params: URLSearchParams) {
  try { localStorage.setItem(key, inventoryViewSearch(params)); } catch { /* Storage is optional. */ }
}
