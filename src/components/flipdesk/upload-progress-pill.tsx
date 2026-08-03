import { NavLink } from "react-router-dom";
import { Loader2, TriangleAlert } from "lucide-react";
import { useAutolisterUploadStore } from "@/stores/autolister-upload-store";

// US-1542: global affordance for the app-level AutoLister upload queue. The
// pipeline keeps running while the user browses other pages — this pill (in
// the dashboard sidebar, so it's visible everywhere) shows live progress and
// links back to the intake page. Renders nothing when the queue is idle and
// clean, so it costs nothing outside a bulk-intake session.
export function UploadProgressPill() {
  const tasks = useAutolisterUploadStore((s) => s.tasks);
  if (tasks.length === 0) return null;

  const done = tasks.filter((t) => t.status === "done").length;
  const failed = tasks.filter((t) => t.status === "error").length;
  const active = tasks.length - done - failed;
  if (active === 0 && failed === 0) return null;

  return (
    <NavLink
      to="/dashboard/flipdesk/autolister"
      className="mx-3 mb-2 flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-white/15"
    >
      {active > 0 ? (
        <>
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          <span className="truncate">
            Uploading {done} of {tasks.length}
            {failed > 0 ? ` · ${failed} failed` : ""}
          </span>
        </>
      ) : (
        <>
          <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-brand-red-text" />
          <span className="truncate">
            {failed} upload{failed === 1 ? "" : "s"} failed — review
          </span>
        </>
      )}
    </NavLink>
  );
}
