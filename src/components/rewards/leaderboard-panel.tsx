import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Award, Share2, Sparkles, Trophy, Zap, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type LeaderboardPeriod,
  useMyLeaderboard,
  useSetLeaderboardOptIn,
} from "@/hooks/use-leaderboards";

// US-1856: the seller's own view of the public leaderboards — join, choose the
// name you appear under, and see where you currently stand.
//
// The opt-in is SEPARATE from the referral-board opt-in (US-864) and the buyer
// one (US-1814) on purpose. Each of those toggles' copy names what it publishes;
// these boards publish XP, graded volume and reactions, which neither sentence
// covers. Reusing an old toggle would make a promise somebody already read
// retroactively untrue, so this card states its own terms.

const ICONS: Record<string, LucideIcon> = { Award, Share2, Sparkles, Zap };

const PERIODS: { key: LeaderboardPeriod; label: string }[] = [
  { key: "weekly", label: "This week" },
  { key: "all_time", label: "All time" },
];

function num(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1);
}

export function LeaderboardPanel() {
  const [period, setPeriod] = useState<LeaderboardPeriod>("all_time");
  const [alias, setAlias] = useState("");
  const { data, isLoading, isError } = useMyLeaderboard(period);
  const save = useSetLeaderboardOptIn();

  // Seed the alias box from whatever the seller would appear as, so the field
  // shows the truth rather than an empty box beside a filled fallback.
  const savedAlias = data?.alias ?? data?.resolved_alias ?? "";
  useEffect(() => {
    setAlias(savedAlias);
  }, [savedAlias]);

  // A failed read is not worth a red block on the rewards page — the boards are
  // an extra, and the level/season cards above still tell the whole story.
  if (isError) return null;

  const optIn = data?.opt_in === true;
  const trimmed = alias.trim();

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Trophy className="h-5 w-5 text-primary" />
          Leaderboards
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Four public boards — XP, grades, best finds and share-driven signups —
          ranked this week and all time. Joining publishes the name you choose,
          your rank and your score on each board. Nothing else: never your email,
          your real name or your account.{" "}
          <Link to="/leaderboards" className="font-medium hover:underline">
            See the boards
          </Link>
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="leaderboard-alias" className="text-xs text-muted-foreground">
            Public display name
          </Label>
          <Input
            id="leaderboard-alias"
            value={alias}
            onChange={(e) => setAlias(e.target.value.slice(0, 40))}
            placeholder="e.g. ThriftKing"
            maxLength={40}
          />
          {!data?.alias && data?.resolved_alias ? (
            <p className="text-xs text-muted-foreground">
              Leave this as-is to reuse the name you already use publicly.
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {optIn ? "You're on the boards." : "You're not on the boards yet."}
          </p>
          <div className="flex gap-2">
            {optIn ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={save.isPending || !trimmed}
                  onClick={() => save.mutate({ alias: trimmed || null })}
                >
                  Save name
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={save.isPending}
                  onClick={() => save.mutate({ enabled: false })}
                >
                  Hide me
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                disabled={save.isPending || (!trimmed && !data?.resolved_alias)}
                onClick={() =>
                  save.mutate({ enabled: true, alias: trimmed || null })}
              >
                {save.isPending ? "Saving…" : "Join the boards"}
              </Button>
            )}
          </div>
        </div>

        {optIn && !isLoading ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              {PERIODS.map((p) => (
                <Button
                  key={p.key}
                  size="sm"
                  variant={period === p.key ? "default" : "outline"}
                  onClick={() => setPeriod(p.key)}
                >
                  {p.label}
                </Button>
              ))}
            </div>
            <ul className="space-y-2">
              {(data?.standings ?? []).map((s) => {
                const Icon = ICONS[s.icon] ?? Trophy;
                return (
                  <li key={s.metric} className="flex items-center gap-3 text-sm">
                    <Icon
                      className="h-4 w-4 flex-shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <Link to={s.path} className="min-w-0 flex-1 truncate hover:underline">
                      {s.name}
                    </Link>
                    {s.rank == null ? (
                      // A zero score is "not on this board yet", never "last".
                      // Inventing a position would be a number nobody earned.
                      <Badge variant="outline" className="text-xs">
                        Not ranked yet
                      </Badge>
                    ) : (
                      <>
                        <span className="text-muted-foreground tabular-nums">
                          {num(s.score)} {s.score_label.toLowerCase()}
                        </span>
                        <span className="font-semibold tabular-nums">
                          #{s.rank}
                          {s.tied ? "=" : ""}
                        </span>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
