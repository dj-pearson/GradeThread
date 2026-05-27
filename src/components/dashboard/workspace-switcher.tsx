import { Check, ChevronsUpDown, Users } from "lucide-react";
import { useWorkspace } from "@/hooks/use-workspace";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WORKSPACE_ROLE_LABEL } from "@/lib/workspace-permissions";

export function WorkspaceSwitcher() {
  const { workspaces, activeWorkspace, workspaceOwnerId, switchWorkspace } =
    useWorkspace();

  // Don't render the switcher if the user is only in their own workspace.
  if (workspaces.length <= 1) return null;

  const label =
    activeWorkspace?.isPersonal
      ? "Personal"
      : activeWorkspace?.ownerName ||
        activeWorkspace?.ownerEmail ||
        "Workspace";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Users className="h-4 w-4" />
          <span className="max-w-[140px] truncate">{label}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Switch workspace</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {workspaces.map((w) => (
          <DropdownMenuItem
            key={w.ownerId}
            onClick={() => switchWorkspace(w.ownerId)}
            className="flex items-start gap-2"
          >
            <Check
              className={`mt-0.5 h-4 w-4 ${
                w.ownerId === workspaceOwnerId ? "opacity-100" : "opacity-0"
              }`}
            />
            <div className="flex-1 min-w-0">
              <div className="truncate text-sm font-medium">
                {w.isPersonal
                  ? "Personal"
                  : w.ownerName || w.ownerEmail || "Workspace"}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {WORKSPACE_ROLE_LABEL[w.role]}
                {!w.isPersonal && w.ownerEmail ? ` · ${w.ownerEmail}` : ""}
              </div>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
