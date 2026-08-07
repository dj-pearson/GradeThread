import { Link } from "react-router";
import { BadgeCheck, Heart } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { PublicFind } from "@/hooks/use-showcase";
import { cn } from "@/lib/utils";

// US-1855: one card in the public Showcase / "Finds" feed.
//
// Shared by the /finds page and the landing-page strip so the two can never
// describe a find differently. Mirrors the SSR card in
// functions/finds/[[path]].ts — same fields, same links.

export function findValueLabel(cents: number | null): string | null {
  if (cents == null || !Number.isFinite(cents)) return null;
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

function gradeColor(score: number): string {
  if (score > 7) return "text-green-600 dark:text-green-400";
  if (score >= 5) return "text-yellow-600 dark:text-yellow-400";
  return "text-red-600 dark:text-red-400";
}

export function FindCard({
  find,
  reacted,
  onReact,
  reactionPending,
}: {
  find: PublicFind;
  reacted?: boolean;
  /** Omitted for a read-only strip (e.g. the landing page). */
  onReact?: (findId: string) => void;
  reactionPending?: boolean;
}) {
  const value = findValueLabel(find.value_cents);
  const certPath = `/cert/${find.certificate_id}`;
  return (
    <article className="overflow-hidden rounded-xl border bg-card">
      <Link to={certPath} className="block aspect-square overflow-hidden bg-muted">
        <img
          src={find.image_url}
          alt={`${find.title} — condition-graded ${find.overall_score.toFixed(1)} out of 10`}
          loading="lazy"
          width={400}
          height={400}
          className="h-full w-full object-cover transition-transform duration-200 hover:scale-105"
        />
      </Link>
      <div className="space-y-2 p-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 flex-1 truncate font-semibold">
            <Link to={certPath} className="hover:underline">
              {find.title}
            </Link>
          </h3>
          <span className={cn("text-lg font-bold tabular-nums", gradeColor(find.overall_score))}>
            {find.overall_score.toFixed(1)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline" className="text-xs">
            {find.grade_tier}
          </Badge>
          {find.brand ? <span className="truncate">{find.brand}</span> : null}
          {value ? <span className="font-medium text-foreground">{value}</span> : null}
        </div>
        <div className="flex items-center justify-between gap-3">
          {find.seller_handle ? (
            <Link
              to={`/verified/${find.seller_handle}`}
              className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground hover:underline"
            >
              <BadgeCheck className="h-3.5 w-3.5 flex-shrink-0 text-brand-navy dark:text-brand-red-text" />
              <span className="truncate">
                {find.seller_display_name ?? find.seller_handle}
              </span>
            </Link>
          ) : (
            <span className="text-sm text-muted-foreground">Anonymous seller</span>
          )}
          {onReact ? (
            <Button
              size="sm"
              variant={reacted ? "default" : "outline"}
              disabled={reactionPending}
              onClick={() => onReact(find.id)}
              aria-pressed={reacted === true}
              aria-label={
                reacted
                  ? `Remove your reaction from ${find.title}`
                  : `React to ${find.title}`
              }
            >
              <Heart className={cn("h-4 w-4", reacted && "fill-current")} />
              <span className="tabular-nums">{find.reactions}</span>
            </Button>
          ) : (
            <span className="flex items-center gap-1 text-sm text-muted-foreground">
              <Heart className="h-4 w-4" />
              <span className="tabular-nums">{find.reactions}</span>
            </span>
          )}
        </div>
      </div>
    </article>
  );
}
