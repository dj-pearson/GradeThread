import { useEffect, useState } from "react";
import { MailCheck } from "lucide-react";
import { resendConfirmationEmail, signOut } from "@/lib/auth";
import { AUTH_RATE_LIMIT_MESSAGE, classifyAuthFailure } from "@/lib/auth-error";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";

// US-366: shown when a session exists but the email is unverified. The edge
// rejects every authenticated request from such a session (403 email_unverified),
// so the app would be unusable anyway — this gives a clear "confirm your email"
// state with a resend path instead of a stream of failed requests.
// US-1431: how long the resend button stays disabled after a send. Long enough
// to discourage hammering GoTrue's own rate limit, short enough that a user who
// truly didn't get the email can retry without reloading the page.
const RESEND_COOLDOWN_SECONDS = 45;

export function VerifyEmailGate({ email }: { email: string | null }) {
  const [sending, setSending] = useState(false);
  // US-1431: a ticking cooldown replaces the old permanent "sent" lock, which
  // disabled the button forever and stranded a user whose email never arrived.
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function handleResend() {
    if (!email || sending || cooldown > 0) return;
    setSending(true);
    try {
      await resendConfirmationEmail(email);
      setCooldown(RESEND_COOLDOWN_SECONDS);
      toast.success("Confirmation email sent. Check your inbox.");
    } catch (err) {
      // US-1431 AC3: a GoTrue 429 ("too many sends") is not a generic failure —
      // say so distinctly and start the cooldown so the user stops hammering the
      // rate limit instead of retrying into more 429s.
      if (classifyAuthFailure(err) === "rate_limit") {
        setCooldown(RESEND_COOLDOWN_SECONDS);
        toast.error(AUTH_RATE_LIMIT_MESSAGE);
      } else {
        toastError(err, "Failed to resend email");
      }
    } finally {
      setSending(false);
    }
  }

  const resendLabel = sending
    ? "Sending..."
    : cooldown > 0
      ? `Resend in ${cooldown}s`
      : "Resend confirmation email";

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-gray p-4 dark:bg-brand-night">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-brand-red/10">
            <MailCheck className="h-6 w-6 text-brand-red-text" />
          </div>
          <CardTitle>Confirm your email</CardTitle>
          <CardDescription>
            {email ? (
              <>
                We sent a confirmation link to <strong>{email}</strong>. Click it
                to activate your account, then refresh this page.
              </>
            ) : (
              <>Please confirm your email address to continue.</>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            className="w-full"
            onClick={handleResend}
            disabled={sending || cooldown > 0 || !email}
          >
            {resendLabel}
          </Button>
        </CardContent>
        <CardFooter className="justify-center">
          <button
            type="button"
            onClick={() => void signOut()}
            className="text-sm text-muted-foreground hover:underline"
          >
            Sign in with a different account
          </button>
        </CardFooter>
      </Card>
    </div>
  );
}
