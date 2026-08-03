import { useNavigate } from "react-router";
import {
  LogOut,
  Settings,
  CreditCard,
  Shield,
  Sun,
  Moon,
  Keyboard,
} from "lucide-react";
import { signOut } from "@/lib/auth";
import { useAuth } from "@/hooks/use-auth";
import { useThemeStore } from "@/stores/theme-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MobileNav } from "@/components/dashboard/sidebar";
import { NotificationCenter } from "@/components/dashboard/notification-center";
import { OPEN_SHORTCUTS_EVENT } from "@/components/dashboard/shortcuts-help";
import { SupportLauncher } from "@/components/dashboard/support-launcher";
import { WorkspaceSwitcher } from "@/components/dashboard/workspace-switcher";

export function Header() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();

  const initials = profile?.full_name
    ? profile.full_name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
    : user?.email?.[0]?.toUpperCase() ?? "?";

  // Use flipdesk_plan (the current subscription tier, same field the Billing
  // page reads) — NOT the deprecated `plan` column, which is stale and made the
  // header show "Free" while Billing correctly showed Business.
  const planLabel = profile?.flipdesk_plan
    ? profile.flipdesk_plan.charAt(0).toUpperCase() + profile.flipdesk_plan.slice(1)
    : "Free";

  const { theme, toggleTheme } = useThemeStore();

  async function handleSignOut() {
    await signOut();
    navigate("/login");
  }

  return (
    <header className="flex h-16 items-center justify-between border-b bg-card px-6">
      <div className="flex items-center gap-3">
        <MobileNav />
        <WorkspaceSwitcher />
        <Badge variant="secondary" className="text-xs font-medium">
          {planLabel} Plan
        </Badge>
      </div>

      <div className="flex items-center gap-2">
        <NotificationCenter />

        <SupportLauncher />

        <Button
          variant="ghost"
          size="icon"
          className="hidden sm:inline-flex"
          onClick={() =>
            window.dispatchEvent(new CustomEvent(OPEN_SHORTCUTS_EVENT))
          }
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
        >
          <Keyboard className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          onClick={toggleTheme}
          aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
        >
          {theme === "light" ? (
            <Moon className="h-4 w-4" />
          ) : (
            <Sun className="h-4 w-4" />
          )}
        </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            aria-label="Account menu"
            className="flex items-center gap-2 rounded-full outline-none ring-ring focus-visible:ring-2"
          >
            <Avatar className="h-8 w-8">
              <AvatarImage src={profile?.avatar_url ?? undefined} />
              <AvatarFallback className="bg-primary text-primary-foreground text-xs">
                {initials}
              </AvatarFallback>
            </Avatar>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <div className="px-2 py-1.5 text-sm">
            <p className="font-medium">{profile?.full_name ?? "User"}</p>
            <p className="text-xs text-muted-foreground">{user?.email}</p>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => navigate("/dashboard/account?tab=settings")}
          >
            <Settings className="mr-2 h-4 w-4" />
            Settings
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => navigate("/dashboard/account?tab=billing")}
          >
            <CreditCard className="mr-2 h-4 w-4" />
            Billing
          </DropdownMenuItem>
          {(profile?.role === "admin" || profile?.role === "super_admin") && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => navigate("/admin")}>
                <Shield className="mr-2 h-4 w-4" />
                Admin Panel
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleSignOut}>
            <LogOut className="mr-2 h-4 w-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      </div>
    </header>
  );
}
