// AL-05: when the Drafts cockpit's single-letter shortcuts must stay out of the
// way. The window handler used to fire on Ctrl/Cmd+P (publishing to eBay with
// no confirm), hijack Enter on focused buttons and links, and act on the table
// while a dialog was open over it.

/** Roles that handle Enter and Space themselves. */
const ACTIVATE_ROLES = new Set(["button", "checkbox", "link", "switch"]);

/** Roles that also move with the arrow keys (and type-ahead) themselves. */
const NAVIGATING_ROLES = new Set([
  "combobox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "tab",
]);

const ACTIVATE_KEYS = new Set(["Enter", " "]);
const ARROW_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

type HotkeyEvent = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "metaKey" | "altKey" | "repeat" | "defaultPrevented" | "target"
>;

/**
 * True when a cockpit shortcut must NOT act on this keydown: a modified key
 * (browser and OS shortcuts), auto-repeat, an event something else already
 * handled, anything inside a dialog, or a key a focused control handles itself
 * (Enter/Space on a button or link, arrows on a tab or option). Letters still
 * reach the cockpit from a focused button: a clicked draft row is a focusable
 * role="button", and swallowing every key there made j/k/e/x/a/p dead after
 * any click on the table. Text inputs are handled separately by the caller
 * (typing, the editor, "/"), so they are not decided here.
 */
export function shouldIgnoreDraftsHotkey(e: HotkeyEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.defaultPrevented) return true;
  const el = e.target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  if (el.closest("[role=dialog], [role=alertdialog]")) return true;
  if (el.isContentEditable) return true;
  const role = el.getAttribute("role");
  const tag = el.tagName;
  const activates = tag === "BUTTON" || tag === "A" || (role != null && ACTIVATE_ROLES.has(role));
  if (activates && ACTIVATE_KEYS.has(e.key)) return true;
  if (role != null && NAVIGATING_ROLES.has(role)) {
    return ACTIVATE_KEYS.has(e.key) || ARROW_KEYS.has(e.key) || e.key.length === 1;
  }
  return false;
}
