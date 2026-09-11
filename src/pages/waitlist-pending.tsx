import { useEffect } from "react";
import { Link } from "react-router";
import { Clock, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { signOut } from "@/lib/auth";
import { useAuthStore } from "@/stores/auth-store";
import { joinWaitlistOnce } from "@/lib/waitlist-join";
import { SEO } from "@/components/seo";

// US-585: shown to an authenticated account that is NOT yet approved while the
// launch gate is active. edge-fetch redirects here on a 403
// { code: "waitlist_required" }. Public route so it renders even when every
// gated API call is being blocked.
export function WaitlistPendingPage() {
  // US-2449: put this account ON the list it is being told it is on.
  //
  // Signup does not create a waitlist_entries row — nothing did except the
  // public form, and the public form had no importers. So a person who signed
  // up while the gate was closed landed here reading "you're in the queue"
  // while /admin/waitlist showed nothing to approve. The page said something
  // that was not true and the operator had no way to find out.
  //
  // POST is idempotent (unique email column + ON CONFLICT DO NOTHING), so an
  // already-approved entry is never downgraded and a repeat visit is a no-op.
  //
  // Failure is still silent FOR THE VISITOR, and that part of the original
  // reasoning is right: they are stuck either way and a toast about a
  // background write they did not ask for helps nobody.
  //
  // US-3379: it was also silent for the OPERATOR, which was the bug. The call
  // was `void edgeFetch(...).catch(() => {})`, and edgeFetch resolves on a
  // non-2xx rather than throwing, so a 500 wrote no row, raised nothing, and
  // left this page saying something untrue with nobody able to find out.
  // joinWaitlistOnce keeps the visitor's experience byte-identical and retries,
  // then reports a genuinely lost join to Sentry. See src/lib/waitlist-join.ts
  // for the channel, the payload and the recovery query.
  const email = useAuthStore((s) => s.user?.email);
  const userId = useAuthStore((s) => s.user?.id);
  const fullName = useAuthStore((s) => s.profile?.full_name);
  useEffect(() => {
    if (!email) return;
    joinWaitlistOnce({ email, fullName, userId, source: "signup-gated" });
  }, [email, fullName, userId]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-gray px-4 dark:bg-brand-night">
      {/* US-2529: noindex. This is an account-state page: per-account, and with
          nothing on it worth a search result. */}
      <SEO title="You're on the list" noindex />
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
