import { ExternalLink } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useDelistLog } from "@/hooks/use-delist-log";
import { delistLogLine } from "@/lib/delist-log-words";
import { safeHref } from "@/lib/safe-url";

// US-3452: the delist log, rendered. "Sold on eBay 14:02. Poshmark ended
// 14:06, your browser. Grailed: still live." Renders nothing for an item with
// no sale story, so it costs an unsold item no space.
//
// `bare` drops the card chrome for the Record Sale confirmation, where the
// dialog is already the frame.

export function DelistLog({ itemId, bare = false }: { itemId: string; bare?: boolean }) {
  const { data: events = [] } = useDelistLog(itemId);
  if (events.length === 0) return null;

  const list = (
    <ol className="space-y-1.5 text-sm" aria-label="What happened after the sale">
      {events.map((e, i) => {
        const line = delistLogLine(e);
        const href = safeHref(e.url);
        return (
          <li key={`${e.platform}-${e.event}-${i}`} className="flex flex-wrap items-baseline gap-x-2">
            <span className={cn("font-medium", line.open && "text-brand-red-text")}>
              {line.headline}
            </span>
            <span className="text-muted-foreground">{line.detail}</span>
            {line.open && href && (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs underline underline-offset-2"
              >
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
                Open the listing
              </a>
            )}
          </li>
        );
      })}
    </ol>
  );

  if (bare) return list;
  return (
    <Card>
      <CardHeader>
        <CardTitle>After the sale</CardTitle>
        <CardDescription>What ended, where, when and by whom.</CardDescription>
      </CardHeader>
      <CardContent>{list}</CardContent>
    </Card>
  );
}
