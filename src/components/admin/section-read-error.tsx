import { Card } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";

/**
 * One admin SECTION could not read its data (US-2555).
 *
 * The admin pages this exists for run three to six independent queries each, so
 * a single page-level banner is the wrong shape: it would either hide four
 * working sections because one failed, or say nothing about which one did. Each
 * section reports its own failure, next to the space its data would have filled.
 *
 * The shape it replaces, repeated across nine pages:
 *
 *     if (isLoading) return <Skeleton />;
 *     if (!data) return null;          // ← a failed read renders NOTHING
 *
 * react-query leaves `data` undefined on an error as well as before a load, so
 * that second line quietly turned an outage into a section that simply was not
 * there. Nothing spun, nothing claimed "no data", and an operator had no way to
 * tell a broken read from a quiet day.
 */
export function SectionReadError({
  title,
  description = "The data is unchanged — this is a read failure, not a loss.",
  onRetry,
  retrying,
}: {
  title: string;
  description?: string;
  onRetry: () => void;
  retrying?: boolean;
}) {
  return (
    <Card>
      <ErrorState
        title={title}
        description={description}
        onRetry={onRetry}
        retrying={retrying}
      />
    </Card>
  );
}
