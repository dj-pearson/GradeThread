import { Link } from "react-router";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RewardAction } from "@/lib/reward-actions";

/** One tap from a goal, quest, badge or reward back to the work that moves it. */
export function RewardActionLink({ action }: { action: RewardAction }) {
  return (
    <Button asChild variant="ghost" size="sm" className="-ml-3 h-7 px-3 text-xs">
      <Link to={action.href}>
        {action.label}
        <ArrowRight className="ml-1 h-3 w-3" aria-hidden="true" />
      </Link>
    </Button>
  );
}
