import { useState } from "react";
import { MailCheck } from "lucide-react";
import { resendConfirmationEmail, signOut } from "@/lib/auth";
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

// US-366: shown when a session exists but the email is unverified. The edge
// rejects every authenticated request from such a session (403 email_unverified),
// so the app would be unusable anyway — this gives a clear "confirm your email"
// state with a resend path instead of a stream of failed requests.
export function VerifyEmailGate({ email }: { email: string | null }) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleResend() {
    if (!email) return;
    setSending(true);
    try {
      await resendConfirmationEmail(email);
      setSent(true);
      toast.success("Confirmation email sent. Check your inbox.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to resend email");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-gray p-4 dark:bg-brand-night">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-brand-red/10">
            <MailCheck className="h-6 w-6 text-brand-red" />
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
            disabled={sending || sent || !email}
          >
            {sending ? "Sending..." : sent ? "Email sent" : "Resend confirmation email"}
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
