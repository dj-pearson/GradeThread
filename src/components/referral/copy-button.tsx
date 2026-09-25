import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// One copy action for the referral page. It has an accessible name that says
// what it copies, announces "Copied" to screen readers as well as showing it,
// clears its timer on unmount, and never shows success when the clipboard
// refused: the failure is a toast, and the button stays as it was.
const COPIED_MS = 1800;

export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  /** What is copied, lowercase: "referral link" reads "Copy referral link". */
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      toast.error("Couldn't copy. Select the text and copy it yourself.");
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={copy}
        aria-label={copied ? "Copied" : `Copy ${label}`}
        className={cn("shrink-0", className)}
      >
        {copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
        <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
      </Button>
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </>
  );
}
