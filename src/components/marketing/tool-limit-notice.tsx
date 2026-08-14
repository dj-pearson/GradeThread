import { Link } from "react-router";
import { ArrowRight, Timer } from "lucide-react";
import { Button } from "@/components/ui/button";

// US-2526: a free tool that has hit its per-IP limit says so.
//
// Every non-OK response used to render through the same red line as a grading
// failure — "Couldn't grade that photo. Try a clearer, well-lit shot." — so a
// visitor who had simply used the tool three times went and retook a photo that
// was fine, and then hit the limit again. That is the worst possible moment to
// blame someone's photography: they were mid-conversion.

export function ToolLimitNotice({
  toolLabel,
  message,
}: {
  /** e.g. "grade checks" — used in the sentence about what ran out. */
  toolLabel: string;
  /** The server's own wording, when it sent one. */
  message?: string | null;
}) {
  return (
    <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4 text-center">
      <Timer className="mx-auto h-5 w-5 text-amber-600 dark:text-amber-400" />
      <p className="mt-2 font-medium">
        You've used up the free {toolLabel} for now
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {message ??
          "The free tool is limited per visitor so it stays free for everyone."}{" "}
        Nothing was wrong with your photo. An account lifts the limit and keeps
        your results.
      </p>
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        <Link to="/signup">
          <Button size="sm">
            Create a free account
            <ArrowRight className="ml-1 h-4 w-4" />
          </Button>
        </Link>
        <Link to="/pricing">
          <Button size="sm" variant="outline">
            See plans
          </Button>
        </Link>
      </div>
    </div>
  );
}
