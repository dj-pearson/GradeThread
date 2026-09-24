// AL-05: when the Drafts cockpit's single-letter shortcuts must stay out of the
// way. The window handler used to fire on Ctrl/Cmd+P (publishing to eBay with
// no confirm), hijack Enter on focused buttons and links, and act on the table
// while a dialog was open over it.

/** Roles whose own keyboard behaviour (Space/Enter/arrows) a shortcut must not steal. */
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "switch",
  "tab",
]);

type HotkeyEvent = Pick<
  KeyboardEvent,
  "ctrlKey" | "metaKey" | "altKey" | "repeat" | "defaultPrevented" | "target"
>;

/**
 * True when a cockpit shortcut must NOT act on this keydown: a modified key
 * (browser and OS shortcuts), auto-repeat, an event something else already
 * handled, anything inside a dialog, or a focused control with its own key
 * behaviour. Text inputs are handled separately by the caller (typing, the
 * editor, "/"), so they are not decided here.
 */
export function shouldIgnoreDraftsHotkey(e: HotkeyEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.defaultPrevented) return true;
  const el = e.target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  if (el.closest("[role=dialog], [role=alertdialog]")) return true;
  const tag = el.tagName;
  if (tag === "BUTTON" || tag === "A") return true;
  if (el.isContentEditable) return true;
  const role = el.getAttribute("role");
  return role != null && INTERACTIVE_ROLES.has(role);
}
