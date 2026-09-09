import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { NavigationGuard } from "@/hooks/use-navigation-guard";

// The dialog half of useNavigationGuard (US-3243).
//
// The hook has existed since US-2032, but every caller hand-rolled its own
// 25-line AlertDialog, so wiring a new page up cost more than it should and the
// copy drifted. This is that block, once. It lives beside the hook rather than
// in components/ui, which is shadcn-generated and must not be hand-edited.
//
// `count` exists because "You have unsaved changes" is the copy people click
// through. A number is the part that makes someone stop, and the bulk grid and
// the cell grid both have one to give.

export interface UnsavedChangesDialogProps {
  guard: NavigationGuard;
  /** What is about to be discarded, e.g. "row", "change". */
  noun: string;
  /** How many of them. Omit for a surface that cannot count. */
  count?: number;
}

export function UnsavedChangesDialog({
  guard,
  noun,
  count,
}: UnsavedChangesDialogProps) {
  const plural = count === 1 ? "" : "s";
  const title =
    count == null
      ? "Leave without saving?"
      : `Leave without saving ${count} ${noun}${plural}?`;
  const description =
    count == null
      ? `You have ${noun}s that haven't been saved. Leaving now discards them.`
      : `${count === 1 ? `One ${noun} has` : `${count} ${noun}${plural} have`} edits that haven't been saved yet. Leaving now discards them.`;

  return (
    <AlertDialog
      open={guard.blocked}
      onOpenChange={(open) => {
        if (!open) guard.cancelLeave();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={guard.cancelLeave}>
            Keep editing
          </AlertDialogCancel>
          <AlertDialogAction onClick={guard.confirmLeave}>
            Leave and discard
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
