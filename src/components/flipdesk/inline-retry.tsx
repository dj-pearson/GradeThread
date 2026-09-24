import { Button } from "@/components/ui/button";

// MP-11: the one-line "couldn't load" with a retry that the Ads-tab cards show
// in place of their empty copy. A failed read must never read as "no ads",
// "nothing to suggest" or "no discount breaches".
export function InlineRetry({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">{message}</span>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
