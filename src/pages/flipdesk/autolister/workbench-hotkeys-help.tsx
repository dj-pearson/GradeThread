// AL-15: the "?" cheat sheet for the workbench shortcuts.
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const KEYS: [string, string][] = [
  ["Arrow keys", "Move between ungrouped photos"],
  ["Shift + arrows", "Move and add to the selection"],
  ["Space", "Select or unselect this photo"],
  ["g", "Make a new item from the selection"],
  ["1 - 9", "Send the selection to that item"],
  ["Delete", "Delete the selection (you can undo)"],
  ["Esc", "Clear the selection"],
  ["?", "Show this list"],
];

export function WorkbenchHotkeysHelp({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Sort a batch into items without the mouse.</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {KEYS.map(([k, v]) => (
            <div key={k} className="contents">
              <dt>
                <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">{k}</kbd>
              </dt>
              <dd className="text-muted-foreground">{v}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
