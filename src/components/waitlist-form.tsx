import { useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// US-585: public waitlist capture. Anonymous POST to /api/waitlist (rate-limited
// + idempotent server-side). Used on the landing page during the staged launch.
export function WaitlistForm({ source = "landing" }: { source?: string }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "done">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    if (!email.trim()) {
      setErrorMsg("Please enter your email.");
      return;
    }
    setStatus("submitting");
    try {
      // Dynamic import keeps edge-fetch (→ supabase client) out of the landing
      // page's SSR/prerender module graph, which has no VITE_SUPABASE_* env.
      const { edgeFetch } = await import("@/lib/edge-fetch");
      const res = await edgeFetch("/api/waitlist", {
        method: "POST",
        unauthenticated: true,
        json: { email: email.trim(), full_name: name.trim() || undefined, source },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorMsg((json as { error?: string }).error ?? "Something went wrong. Please try again.");
        setStatus("idle");
        return;
      }
      setStatus("done");
    } catch {
      setErrorMsg("Network error. Please try again.");
      setStatus("idle");
    }
  };

  if (status === "done") {
    return (
      <div className="mx-auto flex max-w-md items-center justify-center gap-2 rounded-lg bg-white/10 px-6 py-4 text-white">
        <CheckCircle2 className="h-5 w-5 text-green-300" />
        <span className="text-sm font-medium">You're on the list! We'll be in touch soon.</span>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mx-auto flex w-full max-w-md flex-col gap-3 sm:flex-row">
      <Input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name (optional)"
        className="bg-white text-foreground sm:w-40"
        aria-label="Your name"
      />
      <Input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        className="bg-white text-foreground"
        aria-label="Your email"
      />
      <Button type="submit" disabled={status === "submitting"} className="bg-brand-red text-white hover:bg-brand-red/90">
        {status === "submitting" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Join waitlist"}
      </Button>
      {errorMsg && <p className="text-sm text-red-200 sm:absolute sm:mt-12">{errorMsg}</p>}
    </form>
  );
}
