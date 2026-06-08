import type { LucideIcon } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface EmptyStateAction {
  label: string;
  /** Router destination — renders the button as a Link. */
  to?: string;
  /** Click handler — used when `to` is not provided. */
  onClick?: () => void;
  icon?: LucideIcon;
}

export interface EmptyStateProps {
  /** Lucide icon shown above the title; defaults to a neutral inbox glyph. */
  icon?: LucideIcon;
  title: string;
  description?: string;
  /** Primary call-to-action (e.g. "Add item"). */
  action?: EmptyStateAction;
  /** Secondary action (e.g. "Clear filters" for a no-matches state). */
  secondaryAction?: EmptyStateAction;
  className?: string;
}

function ActionButton({
  action,
  variant,
}: {
  action: EmptyStateAction;
  variant?: "default" | "outline";
}) {
  const Icon = action.icon;
  const inner = (
    <>
      {Icon && <Icon className="mr-1.5 h-4 w-4" />}
      {action.label}
    </>
  );
  if (action.to) {
    return (
      <Button asChild variant={variant}>
        <Link to={action.to}>{inner}</Link>
      </Button>
    );
  }
  return (
    <Button variant={variant} onClick={action.onClick}>
      {inner}
    </Button>
  );
}

/**
 * Consistent empty state for list/table surfaces: icon + heading +
 * description + optional CTA(s). Pass a primary `action` for the "no data
 * yet" case (e.g. "Add your first item") and/or a `secondaryAction` like
 * "Clear filters" for the "no matches" case — the caller decides which copy
 * fits, this component just renders it uniformly.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-6 py-12 text-center",
        className,
      )}
    >
      {Icon && <Icon className="h-12 w-12 text-muted-foreground/50" />}
      <h3 className="mt-4 text-lg font-medium">{title}</h3>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          {description}
        </p>
      )}
      {(action || secondaryAction) && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {action && <ActionButton action={action} />}
          {secondaryAction && (
            <ActionButton action={secondaryAction} variant="outline" />
          )}
        </div>
      )}
    </div>
  );
}
