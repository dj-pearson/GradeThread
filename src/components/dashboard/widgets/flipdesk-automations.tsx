import { useMemo } from "react";
import { Bot } from "lucide-react";
import {
  countActionsSince,
  useAutomationRules,
  useAutomationRuleActionsForRules,
} from "@/hooks/use-automations";
import {
  StatTile,
  StatTileSkeleton,
  WidgetLoadError,
} from "@/components/dashboard/widgets/flipdesk-shared";

// US-3077 AC8: rules that are running, and what they actually did.
//
// The count of active rules on its own is a settings number, not a business
// one: three rules that fired nothing all week look identical to three that
// dropped forty prices. So the sub-line is the WORK, over a fixed seven days.
//
// Seven days, not the overview's picker, because this answers "is the robot
// still alive" and that question has one useful window. The registry marks it
// not range-aware and gives it its own phrase, the same way Time saved does.

/** Rules whose activity logs the widget will read. */
const MAX_RULES_READ = 12;

const WINDOW_DAYS = 7;

export function FlipdeskAutomationsWidget() {
  const rules = useAutomationRules();

  const active = useMemo(
    () => (rules.data ?? []).filter((r) => r.is_active),
    [rules.data],
  );
  // Capped: the activity log is one request per rule, and a seller with fifty
  // rules must not turn a dashboard render into fifty calls. The sub-line says
  // "at least" when the cap bites, rather than under-reporting silently.
  const readIds = useMemo(
    () => active.slice(0, MAX_RULES_READ).map((r) => r.id),
    [active],
  );
  const logs = useAutomationRuleActionsForRules(readIds);

  if (rules.isLoading) return <StatTileSkeleton label="automations" />;
  if (rules.isError) {
    return (
      <WidgetLoadError
        what="your automation rules"
        onRetry={() => void rules.refetch()}
        retrying={rules.isFetching}
      />
    );
  }

  const since = Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const logsLoading = logs.some((q) => q.isLoading);
  const taken = countActionsSince(
    logs.map((q) => q.data),
    since,
  );
  const capped = active.length > readIds.length;

  return (
    <StatTile
      label="Automations"
      icon={<Bot className="h-5 w-5" />}
      value={active.length.toLocaleString()}
      sub={
        active.length === 0
          ? "No rule is running yet"
          : logsLoading
            ? "Counting what they did..."
            : `${capped ? "At least " : ""}${taken} action${taken === 1 ? "" : "s"} in the last ${WINDOW_DAYS} days`
      }
      to="/dashboard/flipdesk/pricing?tab=automations"
    />
  );
}
