import { useNavigate } from "react-router";
import { useAuth } from "@/hooks/use-auth";
import { quickActionsFor } from "@/lib/dashboard-persona-cards";
import { Button } from "@/components/ui/button";

// US-1118's quick actions, moved onto the widget board by US-3075 AC1. The
// list itself lives in src/lib/dashboard-persona-cards.ts.

export function GradingQuickActionsWidget() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const actions = quickActionsFor(profile?.use_case ?? null);

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {actions.map((action) => {
        const Icon = action.icon;
        return (
          <Button
            key={action.key}
            variant="outline"
            className="h-auto justify-start gap-3 py-3"
            onClick={() => navigate(action.to)}
          >
            <Icon className="h-5 w-5 text-primary" aria-hidden="true" />
            <span className="text-left">
              <span className="block text-sm font-medium">{action.label}</span>
              <span className="block text-xs text-muted-foreground">
                {action.sublabel}
              </span>
            </span>
          </Button>
        );
      })}
    </div>
  );
}
