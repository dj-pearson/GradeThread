import { useState } from "react";
import { CheckCircle2, Loader2, Mail } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// US-912: public newsletter capture. Anonymous double-opt-in POST to
// /api/newsletter/subscribe (rate-limited + idempotent server-side). The lead
// must confirm via the email we send before they're emailable. Used on the
// landing page. Mirrors WaitlistForm's prerender-safe dynamic edge-fetch import.
export function NewsletterSignup({ source = "landing" }: { source?: string }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "done">("idle");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const addr = email.trim();
    if (!addr) {
      toast.error("Please enter your email.");
      return;
    }
    setStatus("submitting");
    try {
      // Dynamic import keeps edge-fetch (→ supabase client) out of the landing
      // page's SSR/prerender module graph, which has no VITE_SUPABASE_* env.
      const { edgeFetch } = await import("@/lib/edge-fetch");
      const res = await edgeFetch("/api/newsletter/subscribe", {
        method: "POST",
        unauthenticated: true,
        json: { email: addr, source },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(
          (json as { error?: string }).error ?? "Something went wrong. Please try again.",
        );
        setStatus("idle");
        return;
      }
      setStatus("done");
      toast.success("Almost there — check your inbox to confirm your subscription.");
    } catch {
      toast.error("Network error. Please try again.");
      setStatus("idle");
    }
  };

  if (status === "done") {
    return (
      <div className="mx-auto flex max-w-md items-center justify-center gap-2 rounded-lg bg-white/10 px-6 py-4 text-white">
        <CheckCircle2 className="h-5 w-5 text-green-300" />
        <span className="text-sm font-medium">
          Check your inbox to confirm your subscription.
        </span>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mx-auto flex w-full max-w-md flex-col gap-3 sm:flex-row">
      <Input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        className="bg-white text-foreground"
        aria-label="Your email"
      />
      <Button
        type="submit"
        disabled={status === "submitting"}
        className="bg-brand-red text-white hover:bg-brand-red/90"
      >
        {status === "submitting" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <>
            <Mail className="mr-2 h-4 w-4" />
            Subscribe
          </>
        )}
      </Button>
    </form>
  );
}
