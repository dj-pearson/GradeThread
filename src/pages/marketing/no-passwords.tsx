import { Link } from "react-router";
import { ArrowRight, KeyRound, ShieldCheck, Laptop } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  MarketingLayout,
  MarketingCTA,
} from "@/components/marketing/marketing-layout";

// US-3130: the credential-model page.
//
// WHY IT EXISTS. Every cloud crosslister that supports Poshmark, Mercari, Depop
// or Whatnot has the same problem: those marketplaces publish no seller API, so
// a server that lists on your behalf has to be holding either your password or a
// live session cookie lifted out of your browser. Sellers feel that and search
// for it ("is it safe to give a crosslister my password"), and no tool in the
// category answers the question plainly, because the plain answer is
// uncomfortable for them. It is not uncomfortable for us, which makes this the
// cheapest differentiator we own.
//
// CLAIM DISCIPLINE. Every sentence here has to survive an audit, so the page
// names the mechanism rather than a competitor, states what we DO hold
// (encrypted OAuth tokens, which is not nothing), and admits the cost of our
// choice: for the no-API marketplaces your browser does the posting, so it has
// to be open. Three enforceable facts carry it:
//   1. OAuth for eBay / Etsy / Depop / Shopify / Whatnot, so no password is
//      shared with us at all.
//   2. The extension declares no `cookies` permission
//      (extension-unified/manifest.json) and reads no session anywhere.
//   3. `extension_work_queue` carries a CHECK constraint that REFUSES a row
//      whose payload holds a credential-shaped key at any depth: migration
//      00588, public.jsonb_has_credential_key(). The database rejects the
//      write, so this survives a contributor who never read this comment.
// If any of those three change, this page changes in the same commit.

const CHANNELS: Array<{
  heading: string;
  body: string;
  marketplaces: string;
}> = [
  {
    heading: "Marketplaces with a real seller API",
    body:
      "You approve access on the marketplace's own site and it hands us a scoped token. Your password is typed into their login page, never into ours, and you can revoke us from your marketplace account without changing it. We hold the token, encrypted, and nothing else.",
    marketplaces: "eBay, Etsy, Depop, Shopify, Whatnot",
  },
  {
    heading: "Marketplaces with no seller API",
    body:
      "There is no token to issue, so the work happens in your browser instead of on our servers. Our extension takes the draft we prepared and fills the marketplace's own form in the tab you are already signed in to. Your session never leaves your machine, because the extension never reads it.",
    marketplaces: "Poshmark, Mercari, Grailed, Vinted, Facebook Marketplace",
  },
];

const THREE_WAYS: Array<{
  approach: string;
  holds: string;
  computerOn: string;
}> = [
  {
    approach: "You give the tool your marketplace password",
    holds: "Yes, permanently, until you change it",
    computerOn: "No",
  },
  {
    approach:
      "The tool copies your session out of your browser and replays it from its servers",
    holds: "Yes, a live logged-in session, until it expires",
    computerOn: "No",
  },
  {
    approach: "An extension fills the form inside your own browser",
    holds: "No",
    computerOn: "Yes, for those marketplaces",
  },
];

const FAQS: Array<{ q: string; a: string }> = [
  {
    q: "So GradeThread holds nothing at all?",
    a: "That would not be true, so we will not say it. For eBay, Etsy, Depop, Shopify and Whatnot we hold an OAuth token, encrypted at rest and tied to your account, because that is the only way to list while your computer is off. What we never hold is a password or a session cookie for any marketplace, and you can revoke a token from the marketplace side at any time without touching your password.",
  },
  {
    q: "What is wrong with a tool storing my marketplace password?",
    a: "Two things. A password is not scoped and does not expire, so whoever holds it can do everything you can do for as long as it works, including changing your account details. And logging out does not stop them, because they can log straight back in. A session cookie is better on both counts, but it is still a bearer token: anyone holding it acts as you until it expires.",
  },
  {
    q: "Why does passwordless not always mean what it sounds like?",
    a: "Some tools connect through an extension that reads your live marketplace session out of your browser and sends it to their servers. No password changes hands, which is a genuine improvement. But their servers are then holding a fully privileged session to your account, and they act from their data center rather than from your home connection, which is what triggers the unusual-login lockouts sellers report. Ask any tool what its extension does with your cookies.",
  },
  {
    q: "How would I check that you are telling the truth?",
    a: "Read our extension's permission list before you install it. A browser extension has to declare every permission it uses, and cookie access is one of them. Ours does not ask for it, which means it could not read a session even if the code tried.",
  },
  {
    q: "What does this cost me?",
    a: "For Poshmark, Mercari, Grailed, Vinted and Facebook Marketplace, your browser has to be open when a queued job runs, because your browser is where the credential lives. A tool holding your session can post at three in the morning and we cannot. That is the trade, and it is the only honest version of it.",
  },
];

export function NoPasswordsPage() {
  return (
    <MarketingLayout
      title="Crosslisting without sharing your passwords"
      description="How FlipDesk connects to marketplaces: OAuth where a seller API exists, an extension in your own browser where one does not, and never a stored login."
      canonicalPath="/reselling/crosslisting-without-passwords"
    >
      <section className="px-6 py-16 lg:py-20">
        <div className="mx-auto max-w-3xl">
          <p className="text-sm font-medium text-primary">Credential model</p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">
            We never hold your marketplace login
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            Not your password, and not a copy of your logged-in session. There is
            no box in FlipDesk where you type your Poshmark password, because
            there is nowhere for it to go. The only password we ever hold is the
            one for your GradeThread account.
          </p>
          <p className="mt-4 text-muted-foreground">
            That is a structural choice, not a policy we could quietly change.
            For marketplaces that publish a seller API we use their own approval
            flow. For the ones that do not, the listing is filled in by an
            extension running in your browser, and our database physically
            refuses to store a row carrying a password or a cookie.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link to="/flipdesk">
                See how FlipDesk lists <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/reselling/best-crosslisting-apps">Compare the tools</Link>
            </Button>
          </div>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">
            Two kinds of marketplace, two ways in
          </h2>
          <p className="mt-3 text-muted-foreground">
            Which one applies is decided by the marketplace, not by us. Some
            publish a seller API and some do not, and that single fact
            determines what any tool in this category has to ask you for.
          </p>
          <div className="mt-8 space-y-6">
            {CHANNELS.map((c, i) => (
              <div key={c.heading} className="rounded-2xl bg-background p-6">
                <div className="flex items-start gap-3">
                  {i === 0 ? (
                    <KeyRound
                      className="mt-0.5 h-5 w-5 shrink-0 text-primary"
                      aria-hidden
                    />
                  ) : (
                    <Laptop
                      className="mt-0.5 h-5 w-5 shrink-0 text-primary"
                      aria-hidden
                    />
                  )}
                  <div>
                    <h3 className="font-semibold">{c.heading}</h3>
                    <p className="mt-2 text-muted-foreground">{c.body}</p>
                    <p className="mt-3 text-sm text-muted-foreground">
                      <span className="font-medium text-foreground">
                        Applies to:
                      </span>{" "}
                      {c.marketplaces}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">
            The three ways a tool can list on Poshmark
          </h2>
          <p className="mt-3 text-muted-foreground">
            Poshmark, Mercari, Depop and Whatnot publish no seller API. Every
            tool that lists to them picks one of these, and the choice is the
            whole security story. It is worth knowing which one your current
            tool made.
          </p>
          <div className="mt-8 overflow-x-auto">
            <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b">
                  <th scope="col" className="py-3 pr-4 font-semibold">
                    How it connects
                  </th>
                  <th scope="col" className="py-3 pr-4 font-semibold">
                    Holds your credential?
                  </th>
                  <th scope="col" className="py-3 font-semibold">
                    Computer must be on?
                  </th>
                </tr>
              </thead>
              <tbody>
                {THREE_WAYS.map((w) => (
                  <tr key={w.approach} className="border-b align-top">
                    <td className="py-4 pr-4 text-muted-foreground">
                      {w.approach}
                    </td>
                    <td className="py-4 pr-4 text-muted-foreground">
                      {w.holds}
                    </td>
                    <td className="py-4 text-muted-foreground">
                      {w.computerOn}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-6 text-muted-foreground">
            We took the third one. It is the slower answer, and it is the only
            one that makes the sentence at the top of this page literally true.
          </p>
        </div>
      </section>

      <section className="border-t bg-card px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-start gap-3">
            <ShieldCheck
              className="mt-1 h-6 w-6 shrink-0 text-primary"
              aria-hidden
            />
            <div>
              <h2 className="text-2xl font-bold sm:text-3xl">
                Enforced, not promised
              </h2>
              <p className="mt-3 text-muted-foreground">
                A privacy promise is worth what the code behind it is worth.
                Three things make this one hold whether or not anyone remembers
                it.
              </p>
            </div>
          </div>
          <dl className="mt-8 space-y-6">
            <div>
              <dt className="font-semibold">
                The extension cannot read a cookie
              </dt>
              <dd className="mt-1.5 text-muted-foreground">
                A browser extension must declare every permission it uses, and
                the list is shown to you before you install. Ours does not
                declare cookie access. Not restricted, not carefully used:
                absent. The browser itself would refuse the call.
              </dd>
            </div>
            <div>
              <dt className="font-semibold">The database rejects the write</dt>
              <dd className="mt-1.5 text-muted-foreground">
                The queue carrying listing jobs to your browser has a constraint
                that refuses any job whose contents include a password, a
                cookie, a session or a token, at any depth and under any
                spelling. A change that tried to send one would fail at the
                write, not at review.
              </dd>
            </div>
            <div>
              <dt className="font-semibold">
                Marketplace tokens are encrypted and revocable
              </dt>
              <dd className="mt-1.5 text-muted-foreground">
                The OAuth tokens we do hold are encrypted at rest and bound to
                your account, so one cannot be replayed under a different
                account. You revoke them from the marketplace, not from us,
                which means you never have to trust our delete button.
              </dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="px-6 py-16">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-2xl font-bold sm:text-3xl">
            Questions worth asking us
          </h2>
          <dl className="mt-8 space-y-8">
            {FAQS.map((f) => (
              <div key={f.q}>
                <dt className="font-semibold">{f.q}</dt>
                <dd className="mt-2 text-muted-foreground">{f.a}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <MarketingCTA
        heading="List where you already are, without handing over the keys"
        sub="FlipDesk grades the garment, writes the listing and posts it. Ask any other tool what its extension does with your cookies before you install it."
      />
    </MarketingLayout>
  );
}
