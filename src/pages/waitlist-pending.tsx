import { Link } from "react-router-dom";
import { Clock, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { signOut } from "@/lib/auth";

// US-585: shown to an authenticated account that is NOT yet approved while the
// launch gate is active. edge-fetch redirects here on a 403
// { code: "waitlist_required" }. Public route so it renders even when every
// gated API call is being blocked.
export function WaitlistPendingPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-gray px-4 dark:bg-brand-night">
      <Card className="w-full max-w-md">
        <CardContent className="space-y-6 p-8 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand-navy/10 text-brand-navy dark:bg-white/10 dark:text-white">
            <Clock className="h-7 w-7" />
          </div>
          <div className="space-y-2">
            <h1 className="text-2xl font-bold">You're on the waitlist</h1>
            <p className="text-sm text-muted-foreground">
              GradeThread is rolling out access in stages. Your account is in the
              queue — we'll email you as soon as it's your turn. Thanks for your
              patience!
            </p>
          </div>
          <ul className="space-y-2 text-left text-sm text-muted-foreground">
            <li className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
              We'll send your early-access invite to your account email.
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
              Already invited? Sign out and back in to refresh your access.
            </li>
          </ul>
          <div className="flex flex-col gap-2">
            <Button asChild variant="outline">
              <Link to="/">Back to home</Link>
            </Button>
            <Button variant="ghost" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
