import { Link } from "react-router";
import { ArrowRight, MonitorSmartphone } from "lucide-react";
import { useExtensionQueue } from "@/hooks/use-extension-queue";
import { useExtensionSetup } from "@/hooks/use-extension-setup";
import { usePendingDelists } from "@/hooks/use-pending-delists";
import { usePendingRevises } from "@/hooks/use-pending-revises";
import {
  StatTile,
  StatTileSkeleton,
  WidgetLoadError,
} from "@/components/dashboard/widgets/flipdesk-shared";

// US-3077 AC4: work the extension is holding, and whether anything can run it.
//
// Three queues, one number. The generic extension queue (US-2481) carries
// listings and relists; pending delists (US-717) and pending revises (US-9202)
// are their own reads because the edge stamps them on the listing row rather
// than enqueuing them. All three drain in the seller's own desktop browser and
// nowhere else, which is the ADR this whole mechanism exists under.
//
// THE WORDING RULE, from use-extension-queue.ts and worth repeating: queued is
// not done. Nothing here says "delisted" or "updated" about work the
// marketplace has not confirmed. A seller who believes a delist already ran is
// the seller who sells the same jacket twice.
//
// The no-extension branch is the reason this widget is not just a count. Twelve
// jobs waiting with nothing installed to run them is not a to-do list, it is a
// stall, and it stays a stall indefinitely because nothing else in the app will
// mention it.

export function FlipdeskExtensionQueueWidget() {
  const queue = useExtensionQueue();
  const delists = usePendingDelists();
  const revises = usePendingRevises();
  const setup = useExtensionSetup();

  if (queue.isLoading || delists.isLoading || revises.isLoading) {
    return <StatTileSkeleton label="extension queue" />;
  }

  // Every read down is an outage. One down still leaves two real queues, and
  // hiding those behind an error would cost more than the undercount.
  if (queue.isError && delists.isError && revises.isError) {
    return (
      <WidgetLoadError
        what="your queued extension work"
        onRetry={() => {
          void queue.refetch();
          void delists.refetch();
          void revises.refetch();
        }}
        retrying={queue.isFetching || delists.isFetching || revises.isFetching}
      />
    );
  }

  const pending =
    (queue.data?.pending.length ?? 0) +
    (delists.data?.length ?? 0) +
    (revises.data?.length ?? 0);
  const failed = queue.data?.needsAttention.length ?? 0;

  // `installed` is the DOM marker the extension's bridge drops, so this is a
  // fact about THIS browser, not a claim about the account. A seller with the
  // extension on their laptop sees this on their phone, which is correct: the
  // work still cannot run from here.
  const noExtension = setup.isFetched && !setup.data?.installed;

  if (noExtension && pending + failed > 0) {
    return (
      <div className="rounded-xl border bg-card p-4">
        <p className="text-2xl font-bold tabular-nums">{pending + failed}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          jobs queued, and no extension has checked in from this browser. They
          run when you open a desktop browser with the GradeThread extension
          installed, and not before.
        </p>
        <Link
          to="/connect-extension"
          className="mt-2 inline-flex items-center gap-1 text-sm font-medium underline underline-offset-2 hover:text-foreground"
        >
          Connect the extension
          <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      </div>
    );
  }

  return (
    <StatTile
      label="Extension queue"
      icon={<MonitorSmartphone className="h-5 w-5" />}
      value={pending.toLocaleString()}
      sub={
        failed > 0
          ? `${failed} failed or expired, waiting on you`
          : pending === 0
            ? "Nothing waiting to run"
            : "Runs in your desktop browser"
      }
      to={
        noExtension
          ? "/connect-extension"
          : "/dashboard/flipdesk/marketplaces"
      }
    />
  );
}
