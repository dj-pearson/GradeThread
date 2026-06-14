import { useNavigate } from "react-router-dom";
import {
  HelpCircle,
  BookOpen,
  LifeBuoy,
  Code2,
  Keyboard,
  Activity,
  Mail,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { OPEN_SHORTCUTS_EVENT } from "@/components/dashboard/shortcuts-help";

// In-app help/support launcher for the dashboard shell (US-606). Surfaces the
// help center (FAQ), how-it-works guide, developer docs, the keyboard
// shortcuts cheat-sheet, system status, and a direct line to support — so a
// stuck user always has somewhere to go. US-900: "Contact support" now opens
// the in-app ticket inbox (support lives in the platform) instead of a mailto.
export function SupportLauncher() {
  const navigate = useNavigate();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Help and support"
          title="Help & support"
        >
          <HelpCircle className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Help &amp; support</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate("/faq")}>
          <LifeBuoy className="mr-2 h-4 w-4" />
          Help center
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate("/how-it-works")}>
          <BookOpen className="mr-2 h-4 w-4" />
          How it works
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate("/developers")}>
          <Code2 className="mr-2 h-4 w-4" />
          Developer docs
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() =>
            window.dispatchEvent(new CustomEvent(OPEN_SHORTCUTS_EVENT))
          }
        >
          <Keyboard className="mr-2 h-4 w-4" />
          Keyboard shortcuts
          <kbd className="ml-auto rounded border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            ?
          </kbd>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => navigate("/status")}>
          <Activity className="mr-2 h-4 w-4" />
          System status
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => navigate("/dashboard/support")}>
          <Mail className="mr-2 h-4 w-4" />
          Contact support
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
