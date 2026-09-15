// Remember view choices per person and workspace. Search text, page numbers,
// saved-view loader ids and action links are intentionally not preferences.
const VIEW_PARAMS = ["mode", "sort", "tab", "size", "filter"] as const;
export function inventoryViewKey(userId: string, ownerId: string) {
  return `flipdesk:inventory:last-view:v1:${userId}:${ownerId}`;
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
    return inventoryViewSearch(new URLSearchParams(localStorage.getItem(key) ?? ""));
  } catch { return ""; }
}

export function writeInventoryView(key: string, params: URLSearchParams) {
  try { localStorage.setItem(key, inventoryViewSearch(params)); } catch { /* Storage is optional. */ }
}
