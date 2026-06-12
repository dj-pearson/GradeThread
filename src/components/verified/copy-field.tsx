import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

// Read-only code/text block with a copy-to-clipboard button. Used for the
// verified-badge embed snippets and profile links.

export function CopyField({
  value,
  label,
  multiline = false,
}: {
  value: string;
  label?: string;
  multiline?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy — select and copy manually.");
    }
  }

  return (
    <div className="space-y-1.5">
      {label && (
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
      )}
      <div className="flex items-start gap-2">
        {multiline ? (
          <pre className="flex-1 overflow-x-auto rounded-md border bg-muted px-3 py-2 text-xs leading-relaxed">
            <code>{value}</code>
          </pre>
        ) : (
          <code className="flex-1 truncate rounded-md border bg-muted px-3 py-2 text-xs leading-relaxed">
            {value}
          </code>
        )}
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={copy}
          aria-label="Copy to clipboard"
          className="flex-shrink-0"
        >
          {copied ? (
            <Check className="h-4 w-4 text-green-600 dark:text-green-400" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}
