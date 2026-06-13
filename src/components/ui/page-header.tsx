import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PageHeaderProps {
  /** Page title — rendered as the page's single <h1>. */
  title: ReactNode;
  /** Optional supporting line under the title. */
  subtitle?: ReactNode;
  /** Optional leading icon shown in a brand-navy tile to the left of the title. */
  icon?: LucideIcon;
  /** Right-aligned actions (buttons, menus). Accepts one or many elements. */
  actions?: ReactNode;
  className?: string;
}

/**
 * Consistent page header for dashboard/FlipDesk/settings surfaces: title +
 * optional subtitle on the left, optional action buttons on the right, with the
 * shared responsive layout (stacks on mobile, row on >=sm). Replaces the
 * copy-pasted `<div className="flex … justify-between"><h1>…</h1></div>` block
 * so the heading rhythm is identical everywhere.
 */
export function PageHeader({
  title,
  subtitle,
  icon: Icon,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
    >
      <div className="flex items-center gap-3">
        {Icon && (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-navy text-white">
            <Icon className="h-5 w-5" />
          </div>
        )}
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {subtitle && (
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          )}
        </div>
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
