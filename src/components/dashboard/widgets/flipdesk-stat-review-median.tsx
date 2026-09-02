import { Clock } from "lucide-react";
import { useReviewApproveMedian } from "@/hooks/use-review-flow";
import { formatDuration } from "@/lib/review-flow";
import {
  StatTile,
  StatTileSkeleton,
} from "@/components/dashboard/widgets/flipdesk-shared";

// US-9204, on the board (US-3076): median seconds from first photo to Approve.
//
// Renders nothing until an item has actually been through the review screen.
// A dash, or a zero, for a number nobody has produced yet reads as a broken
// stat rather than as an empty one, so the frame's quiet state says it plainly
// instead.

export function FlipdeskStatReviewMedianWidget() {
  const { data, isLoading } = useReviewApproveMedian();

  if (isLoading) return <StatTileSkeleton label="photos to approve" />;
  if (data?.median == null) return null;

  return (
    <StatTile
      label="Photos to Approve"
      icon={<Clock className="h-5 w-5" />}
      value={formatDuration(data.median)}
      sub={`median over ${data.count} reviewed item${data.count === 1 ? "" : "s"}`}
      to="/dashboard/flipdesk/intake"
    />
  );
}
