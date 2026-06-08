import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

// Inline, per-field error message. role="alert" so screen readers announce it
// when it appears. Wire the field with aria-invalid + aria-describedby={id}.
export function FieldError({
  id,
  children,
  className,
}: {
  id?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  if (!children) return null;
  return (
    <p
      id={id}
      role="alert"
      className={cn("text-sm font-medium text-destructive", className)}
    >
      {children}
    </p>
  );
}

// Summary box listing every field that needs attention, shown at submit so the
// user sees all problems at once instead of hunting field-by-field. Pass the
// already-collected error messages; renders nothing when there are none.
export function FormErrorSummary({
  errors,
  title = "Please fix the following:",
  className,
}: {
  errors: Array<string | undefined | null>;
  title?: string;
  className?: string;
}) {
  const messages = errors.filter((e): e is string => !!e);
  if (messages.length === 0) return null;
  return (
    <div
      role="alert"
      className={cn(
        "flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm",
        className,
      )}
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div>
        <p className="font-medium text-destructive">{title}</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-destructive/90">
          {messages.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
