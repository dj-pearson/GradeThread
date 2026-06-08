import { useEffect, useState } from "react";
import { Keyboard } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";

// Any surface (command palette, header button) can open this dialog by
// dispatching this event — keeps the open-state owned here without a store.
export const OPEN_SHORTCUTS_EVENT = "gradethread:open-shortcuts";

interface Shortcut {
  keys: string[];
  label: string;
}
interface Group {
  title: string;
  items: Shortcut[];
}

// Only list shortcuts that genuinely exist, so the dialog stays trustworthy.
const GROUPS: Group[] = [
  {
    title: "Global",
    items: [
      { keys: ["⌘/Ctrl", "K"], label: "Open command palette" },
      { keys: ["/"], label: "Quick search (open palette)" },
      { keys: ["?"], label: "Show this shortcuts list" },
      { keys: ["Esc"], label: "Close a dialog or the palette" },
    ],
  },
  {
    title: "List pages",
    items: [{ keys: ["N"], label: "New submission / inventory item" }],
  },
  {
    title: "Command palette",
    items: [
      { keys: ["↑", "↓"], label: "Move between results" },
      { keys: ["↵"], label: "Open the selected result" },
    ],
  },
  {
    title: "Inventory grid",
    items: [{ keys: ["⌘/Ctrl", "Z"], label: "Undo cell edits" }],
  },
];

// App-wide keyboard-shortcuts reference. Opens on "?" from anywhere (except
// while typing) and on the OPEN_SHORTCUTS_EVENT. Mounted once in the
// dashboard layout.
export function ShortcutsHelp() {
  const [open, setOpen] = useState(false);

  useKeyboardShortcuts([{ key: "?", handler: () => setOpen((o) => !o) }]);

  useEffect(() => {
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="h-4 w-4" />
            Keyboard shortcuts
          </DialogTitle>
          <DialogDescription>
            Work faster from anywhere in the app.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {GROUPS.map((g) => (
            <div key={g.title}>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {g.title}
              </p>
              <ul className="space-y-1.5">
                {g.items.map((s) => (
                  <li
                    key={s.label}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span className="text-muted-foreground">{s.label}</span>
                    <span className="flex items-center gap-1">
                      {s.keys.map((k) => (
                        <kbd
                          key={k}
                          className="rounded border bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
                        >
                          {k}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
