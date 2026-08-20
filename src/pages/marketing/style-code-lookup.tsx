import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { Search, Circle, Tag, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MarketingLayout } from "@/components/marketing/marketing-layout";
import { edgeFetch } from "@/lib/edge-fetch";
import { track } from "@/lib/analytics";

// US-2750: the front door to the style-code lookup (US-2747).
//
// A reseller holding a Lululemon garment reads the code off its size dot and
// wants the product name. That search happens constantly; this is where it
// lands on gradethread.com.
//
// THE PAGE'S REAL JOB IS THE SECOND SECTION, not the search box. A reseller who
// cannot FIND the code cannot use the tool at all, and "the style number" is
// not a thing most people can point to on a garment. Where it is printed is the
// content; the input is the easy part.

/**
 * The canonical style number inside whatever was typed.
 *
 * Mirrors canonicalStyleCode on the edge, narrowly: strip punctuation and case,
 * drop Lululemon's leading L, and drop the colour letter and manufacture date
 * that follow the six-character style number on a full size-dot string. The
 * edge decides authoritatively — this only exists so an obvious typo is caught
 * before a navigation, and so the URL is the canonical one.
 */
export function canonicalizeTypedCode(raw: string): string | null {
  const norm = (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!norm) return null;
  // [L] + W|M + 4 + colour letter, optionally followed by the colour code and
  // a manufacture date, or by the 2019+ season block.
  const m = norm.match(/^L?([WM][A-Z0-9]{4}[A-Z])(?:[A-Z]\d{5,6}|\d{4})?$/);
  if (m) return m[1]!;
  // A 2019+ code with a longer style group: L + W|M + up to 5 + colour + SSYY.
  const wide = norm.match(/^L?([WM][A-Z0-9]{3,5}[A-Z])\d{4}$/);
  if (wide) return wide[1]!;
  return null;
}

const WHERE = [
  {
    icon: Circle,
    title: "Look for the small printed circle",
    body: "Lululemon prints the code inside a little circle — the size dot. On leggings and pants it is in the waistband key pocket or a back pocket. On tops it is inside the neckband or a hem band.",
  },
  {
    icon: Tag,
    title: "Read the six characters",
    body: "The style number is six characters starting with W for women's or M for men's, like W6AMYS. There is sometimes an L in front of it, and often a colour letter and a date after it. Type the whole thing — we work out which part is the style.",
  },
];

export function StyleCodeLookupPage() {
  const [value, setValue] = useState("");
  const navigate = useNavigate();
  // US-2749: the per-code SSR page links here with ?code=…&tell=1 when it has
  // no answer. The interactive half lives in the SPA rather than in the
  // edge-rendered page, which keeps that page a static document a crawler can
  // read and avoids an inline script under its CSP nonce.
  const [params] = useSearchParams();
  const tellCode = params.get("tell") ? (params.get("code") ?? "").trim() : "";
  const [tellName, setTellName] = useState("");
  const [telling, setTelling] = useState(false);

  async function handleTell(e: FormEvent) {
    e.preventDefault();
    const name = tellName.trim();
    if (!tellCode || !name || telling) return;
    setTelling(true);
    try {
      const res = await edgeFetch(
        `/api/content/public/style-codes/${encodeURIComponent(tellCode)}/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error || "That did not go through");
        return;
      }
      track("style_code_submission", { published: Boolean(body.published) });
      // Told honestly either way: publishing needs a second person to agree,
      // and pretending otherwise would be a nicer message and a lie.
      toast.success(
        body.published
          ? "Thank you — that is now the name we show."
          : "Thank you. We show a name once a second person agrees.",
      );
      setTellName("");
    } catch {
      toast.error("That did not go through");
    } finally {
      setTelling(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const raw = value.trim();
    if (!raw) return;
    track("style_code_lookup", { source: "style_page" });

    const code = canonicalizeTypedCode(raw);
    if (!code) {
      // Said here rather than by navigating to a page that explains it. A
      // round trip to be told the input was wrong is a round trip wasted.
      toast.error("That does not look like a Lululemon style code", {
        description:
          "It is six characters starting with W or M, printed in the size dot — for example W6AMYS.",
      });
      return;
    }
    navigate(`/style/${code}`);
  }

  return (
    <MarketingLayout
      title="Lululemon Style Code Lookup"
      description="Type the style code from a Lululemon size dot and find out which product it is. Free, no account, and every answer shows where it came from."
      canonicalPath="/style"
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-navy/10 px-3 py-1 text-xs font-semibold text-brand-navy dark:text-foreground">
            <Search className="h-3.5 w-3.5" />
            For resellers
          </span>
          <h1 className="mt-4 text-4xl font-bold tracking-tight lg:text-5xl">
            What is this Lululemon style code?
          </h1>
          <p className="mt-4 text-lg text-muted-foreground">
            Type the code from the size dot and we will tell you which product
            it is, and where that answer came from.
          </p>

          <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Input
              aria-label="Lululemon style code"
              placeholder="W6AMYS"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="sm:flex-1"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
            />
            <Button type="submit" size="lg">
              Look it up
              <ArrowRight className="h-4 w-4" />
            </Button>
          </form>

          <p className="mt-3 text-sm text-muted-foreground">
            We are still building this index, so some codes come back unknown.
            If you are holding the garment, you can tell us what it is.
          </p>
        </div>
      </section>

      {tellCode
        ? (
          <section className="px-6 pb-8">
            <div className="mx-auto max-w-3xl rounded-lg border p-6">
              <h2 className="text-xl font-bold tracking-tight">
                What is {tellCode}?
              </h2>
              <p className="mt-2 text-muted-foreground">
                You are holding it, so you know more than we do. No account
                needed.
              </p>
              <form onSubmit={handleTell} className="mt-4 flex flex-col gap-3 sm:flex-row">
                <Input
                  aria-label={`Product name for ${tellCode}`}
                  placeholder="Scuba Oversized Half Zip Hoodie"
                  value={tellName}
                  onChange={(e) => setTellName(e.target.value)}
                  className="sm:flex-1"
                />
                <Button type="submit" disabled={telling || !tellName.trim()}>
                  Send it
                </Button>
              </form>
            </div>
          </section>
        )
        : null}

      <section className="px-6 pb-16 lg:pb-20">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold tracking-tight">
            Where the code is printed
          </h2>
          <div className="mt-6 space-y-6">
            {WHERE.map((item) => (
              <div key={item.title} className="flex gap-4">
                <item.icon
                  aria-hidden="true"
                  className="mt-1 h-5 w-5 shrink-0 text-brand-navy dark:text-foreground"
                />
                <div>
                  <h3 className="font-semibold">{item.title}</h3>
                  <p className="mt-1 text-muted-foreground">{item.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
