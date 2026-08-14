import { forwardRef, useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { checkPassword, passwordStrength } from "@/lib/password-policy";

// US-2530: a password input you can read back, and a strength meter that speaks
// while you type rather than after you submit.
//
// The reveal matters most on a phone, where a mistyped character is invisible
// and comes back as "wrong password" — so the user retypes the same wrong
// thing. The meter matters on signup and reset, where the alternative is
// submitting, being rejected, and guessing which rule was broken.
//
// Lives here rather than in components/ui: that directory is shadcn-generated
// and must not be hand-edited.

const STRENGTH_LABELS = ["Too short", "Weak", "Fair", "Good", "Strong"];
const STRENGTH_TONES = [
  "bg-muted",
  "bg-destructive",
  "bg-amber-500",
  "bg-emerald-500",
  "bg-emerald-600",
];

export interface PasswordFieldProps
  extends Omit<React.ComponentProps<typeof Input>, "type"> {
  /** Show the 0-4 meter and the unmet-rule hint as the user types. */
  showStrength?: boolean;
}

export const PasswordField = forwardRef<HTMLInputElement, PasswordFieldProps>(
  function PasswordField(
    { showStrength = false, className, value, id, ...props },
    ref,
  ) {
    const [revealed, setRevealed] = useState(false);
    const generatedId = useId();
    const inputId = id ?? generatedId;
    const meterId = `${inputId}-strength`;
    const text = typeof value === "string" ? value : "";
    const score = showStrength ? passwordStrength(text) : 0;
    const unmet = showStrength && text ? checkPassword(text).reason : null;

    return (
      <div className="space-y-1.5">
        <div className="relative">
          <Input
            {...props}
            ref={ref}
            id={inputId}
            value={value}
            type={revealed ? "text" : "password"}
            className={cn("pr-10", className)}
            aria-describedby={
              cn(
                props["aria-describedby"],
                showStrength && text ? meterId : undefined,
              ) || undefined
            }
          />
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            // The label names the action pressing it will take, so a screen
            // reader announces what happens next rather than what just did.
            aria-label={revealed ? "Hide password" : "Show password"}
            aria-pressed={revealed}
            className="absolute right-0 top-0 flex h-9 w-10 items-center justify-center rounded-r-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {revealed ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </button>
        </div>

        {showStrength && text.length > 0 && (
          <div id={meterId}>
            <div className="flex gap-1" aria-hidden="true">
              {[1, 2, 3, 4].map((step) => (
                <span
                  key={step}
                  className={cn(
                    "h-1 flex-1 rounded-full transition-colors",
                    step <= score ? STRENGTH_TONES[score] : "bg-muted",
                  )}
                />
              ))}
            </div>
            <p
              className="mt-1 text-xs text-muted-foreground"
              // Announced as it changes, but politely: the user is still typing.
              aria-live="polite"
            >
              {STRENGTH_LABELS[score]}
              {unmet ? ` — ${unmet}` : ""}
            </p>
          </div>
        )}
      </div>
    );
  },
);
