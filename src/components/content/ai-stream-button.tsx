import { Sparkles, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RegenMode } from "@/hooks/use-content-ai-stream";

// US-251: "AI compose" control for the blog editor. Streams an article body
// into the editor in real time and swaps to a Stop button while running, which
// aborts the fetch (and the upstream model call) and discards the rest.
//
// Driven by the shared useContentAiStream hook so it stays in sync with the
// toolbar's section-regen actions (only one stream runs at a time).
interface AiStreamButtonProps {
  isStreaming: boolean;
  onCompose: () => void;
  onStop: () => void;
  // Present so callers that also expose regen share one streaming lock.
  disabled?: boolean;
}

export function AiStreamButton({
  isStreaming,
  onCompose,
  onStop,
  disabled,
}: AiStreamButtonProps) {
  if (isStreaming) {
    return (
      <Button variant="destructive" size="sm" onClick={onStop}>
        <Square className="mr-2 h-4 w-4" />
        Stop
      </Button>
    );
  }
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onCompose}
      disabled={disabled}
      title="Stream a fresh article body into the editor"
    >
      <Sparkles className="mr-2 h-4 w-4" />
      AI compose
    </Button>
  );
}

// Re-exported so the editor page can type its handlers without reaching into
// the hook module directly.
export type { RegenMode };
