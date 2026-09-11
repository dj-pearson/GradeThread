import { Link } from "react-router";
import { Camera } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type PhotoProblem,
  type PhotoReportCard,
  type PhotoSlot,
  usePhotoReportCard,
} from "@/hooks/use-photo-report-card";

// US-3337: the seller's photo report card. Every grade already reads each photo
// for blur, light, framing and label legibility; this shows the seller which
// photo slot most often has a problem, and one thing to do about it.

const SLOT_NAME: Record<PhotoSlot, string> = {
  front: "Front",
  back: "Back",
  label: "Label",
  detail: "Close-up",
  defect: "Flaw",
  measurement: "Measurement",
};

const PROBLEM_WORD: Record<PhotoProblem, string> = {
  blur: "blurry",
  lighting: "too dark",
  framing: "cut off",
  illegible: "hard to read",
};

/** The slot's commonest problem in words, or null when it had none. */
function commonestProblem(slot: PhotoReportCard["slots"][number]): string | null {
  const [top] = (Object.keys(slot.problems) as PhotoProblem[])
    .filter((p) => slot.problems[p].count > 0)
    .sort((a, b) => slot.problems[b].count - slot.problems[a].count);
  return top ? PROBLEM_WORD[top] : null;
}

export function GradingPhotoReportWidget() {
  const { data, isLoading, isError } = usePhotoReportCard();

  if (isLoading) return <Skeleton className="h-32 w-full rounded-xl" />;

  if (isError || !data) {
    return (
      <div className="rounded-xl border border-dashed px-4 py-6" role="alert">
        <p className="text-sm text-muted-foreground">
          Could not load your photo report card just now.
        </p>
      </div>
    );
  }

  return <PhotoReportCardView card={data} />;
}

export function PhotoReportCardView({ card }: { card: PhotoReportCard }) {
  if (card.photos_measured === 0) {
    return (
      <div className="rounded-xl border px-4 py-4">
        <p className="mb-2 flex items-center justify-between gap-2 text-sm font-medium">
          Photo report card
          <Camera className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </p>
        <p className="text-sm text-muted-foreground">
          After your first grade, this shows which of your photos come out blurry, dark
          or cut off, and how to fix them.
        </p>
        <Link
          to="/dashboard/submissions/new"
          className="mt-3 inline-block text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          Grade an item
        </Link>
      </div>
    );
  }

  return (
    <div className="rounded-xl border px-4 py-4">
      <p className="mb-1 flex items-center justify-between gap-2 text-sm font-medium">
        Photo report card
        <Camera className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      </p>
      <p className="text-xs text-muted-foreground">
        {card.photos_measured} photos across your last {card.grades_counted}{" "}
        {card.grades_counted === 1 ? "grade" : "grades"}
      </p>

      <p className="mt-3 text-sm">
        {card.weakest
          ? card.weakest.tip
          : "Your photos are in good shape. No slot stands out."}
      </p>

      <ul className="mt-3 space-y-1.5 text-xs">
        {card.slots.map((s) => {
          const pct = Math.round(s.problem_rate * 100);
          const word = commonestProblem(s);
          return (
            <li key={s.slot} className="grid grid-cols-[6rem_1fr_auto] items-center gap-2">
              <span className="font-medium">{SLOT_NAME[s.slot]}</span>
              <span className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <span
                  className={`block h-full rounded-full ${card.weakest?.slot === s.slot ? "bg-brand-red" : "bg-primary/60"}`}
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="tabular-nums text-muted-foreground">
                {s.with_problems === 0
                  ? `${s.photos} ok`
                  : `${s.with_problems} of ${s.photos} ${word ?? "had problems"}`}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
