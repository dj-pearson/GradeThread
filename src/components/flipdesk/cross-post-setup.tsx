import { Check, Circle, ExternalLink, Loader2, Puzzle } from "lucide-react";
import { Link } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { extensionWebStoreUrl } from "@/lib/lister-extension";
import {
  useExtensionSetup,
  type ExtensionSetupState,
} from "@/hooks/use-extension-setup";
import { cn } from "@/lib/utils";

// US-2719: get a seller from nothing to a working cross-post, in order.
//
// The Marketplaces page already described the extension in a paragraph. What it
// never did was tell anyone where to get it, whether they had it, or which of
// the four things that must be true was the one that was not. The result was a
// super-user of the product concluding cross-listing did not exist — which, in
// the production build, it effectively did not (US-2718).
//
// Four steps because there are exactly four gates, and each one is checked by a
// different thing:
//   1. installed      — the bridge content script's DOM marker.
//   2. signed in      — a signed extension token, minted at /connect-extension.
//   3. terms accepted — a flag in the extension's own storage.
//   4. a live channel — the channel's selectors are verified in that build.
//
// Step 3 has no button here and never will. The Lister clickwrap must render
// from the extension's own copy of the terms, so a page that could accept it
// would be a page granting consent to wording it wrote itself. Saying where it
// happens beats hiding the step, because a seller who cannot find the switch
// concludes the feature is broken rather than unaccepted.

export type StepState = "done" | "todo" | "blocked";

export interface Step {
  key: string;
  title: string;
  body: string;
  state: StepState;
  action?: React.ReactNode;
}

function StepRow({ step, index }: { step: Step; index: number }) {
  const done = step.state === "done";
  return (
    <li className="flex items-start gap-3 rounded-lg border p-3">
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-xs font-semibold",
          done
            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
            : "bg-muted text-muted-foreground",
        )}
      >
        {done ? <Check className="h-3.5 w-3.5" /> : index + 1}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{step.title}</span>
          <Badge
            variant="outline"
            className={cn(
              "text-[10px]",
              done &&
                "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
            )}
          >
            {done ? "Done" : step.state === "blocked" ? "Needs a plan" : "Not yet"}
          </Badge>
        </div>
        <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
          {step.body}
        </p>
        {!done && step.action}
      </div>
    </li>
  );
}

/**
 * The five steps and, for each, whether it is done.
 *
 * EXPORTED SO A TEST CAN CALL IT (US-2719 AC1/AC7). The guards for this screen
 * were source scans asserting that strings like `caps.authenticated === true`
 * appear in the hook, and a scan cannot tell a correct gate from an inverted
 * one. Calling this is what actually holds "four ordered steps with real state"
 * — the same fix US-2739 needed when its six pinned cases turned out to be
 * asserting against a re-implementation of the code they were meant to guard.
 *
 * There are FIVE, not the four the story asked for. Being signed in and being
 * on a paid plan are separate observable facts (capabilities.authenticated vs
 * capabilities.sellerEnabled), and folding them together would show a green
 * step to a free account whose first send then fails with needsUpgrade.
 */
export function buildSteps(s: ExtensionSetupState): Step[] {
  const storeUrl = extensionWebStoreUrl();
  const readyChannels = s.channels.filter((c) => c.canList);

  return [
    {
      key: "install",
      title: "Install the GradeThread extension",
      body:
        "Cross-posting runs in your own browser, on your own logged-in marketplace tab. " +
        "GradeThread never signs in to a marketplace for you, which is why this step exists at all.",
      state: s.installed ? "done" : "todo",
      action: storeUrl ? (
        <Button variant="outline" size="sm" asChild className="mt-1">
          <a href={storeUrl} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
            Get the extension
          </a>
        </Button>
      ) : (
        // Never fall back to a settings page. That is where the buyer home used
        // to send people, and it is not where anyone gets an extension.
        <p className="mt-1 text-xs text-muted-foreground">
          The extension is not published to the store yet. We will link it here
          the moment it is.
        </p>
      ),
    },
    {
      key: "signin",
      title: "Connect it to this account",
      body:
        "Open the extension and choose Sign in. It hands the extension a short-lived token " +
        "so it knows which FlipDesk account to list for. No password and no marketplace cookie is involved.",
      state: s.signedIn ? "done" : "todo",
      action: (
        <Button variant="outline" size="sm" asChild className="mt-1">
          <Link to="/connect-extension">Connect the extension</Link>
        </Button>
      ),
    },
    {
      key: "plan",
      title: "Have an active paid FlipDesk plan",
      body:
        "Cross-posting is a seller feature and unlocks on any paid FlipDesk tier. " +
        "Buyer condition reads stay free either way.",
      state: s.sellerEnabled ? "done" : s.signedIn ? "blocked" : "todo",
      action: (
        <Button variant="outline" size="sm" asChild className="mt-1">
          <Link to="/pricing">See plans</Link>
        </Button>
      ),
    },
    {
      key: "terms",
      title: "Accept the Lister terms",
      body:
        "This one happens in the extension's own window, on purpose: you are agreeing to its wording, " +
        "not ours, so no page on this site is allowed to accept it for you. Open the extension, " +
        "go to Selling, and accept there.",
      state: s.tosAccepted ? "done" : "todo",
    },
    {
      key: "channel",
      title: "Pick a channel and send a draft",
      body: readyChannels.length
        ? `Ready now: ${readyChannels.map((c) => c.label).join(", ")}. ` +
          "Open any item, scroll to the Listing Kit, choose the channel's tab and press Send to extension."
        : "Once the steps above are done, the Listing Kit on any item gains a Send to extension button " +
          "for each channel your build can fill.",
      state: readyChannels.length > 0 && s.tosAccepted && s.sellerEnabled ? "done" : "todo",
    },
  ];
}

export function CrossPostSetup() {
  const { data, isLoading } = useExtensionSetup();

  if (isLoading) {
    return (
      <div>
        <h3 className="mb-3 text-sm font-semibold text-foreground">
          Set up cross-posting
        </h3>
        <div className="flex items-center gap-2 rounded-lg border p-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking your browser for the extension...
        </div>
      </div>
    );
  }

  const state = data ?? null;
  if (!state) return null;

  // A deployment that never switched the bridge on. Nothing the seller does here
  // fixes it, so do NOT hand them an install button and a false trail — say what
  // is true and leave the manual copy-paste path as the answer.
  if (state.unavailable === "disabled") {
    return (
      <div>
        <h3 className="mb-3 text-sm font-semibold text-foreground">
          Set up cross-posting
        </h3>
        <div className="flex items-start gap-3 rounded-lg border border-dashed p-3">
          <Puzzle className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
            One-click cross-posting is switched off for this site right now. The
            channels below still work by hand: every item's Listing Kit gives you
            the fields formatted for each marketplace, plus its photos in the
            right order.
          </p>
        </div>
      </div>
    );
  }

  const steps = buildSteps(state);
  const remaining = steps.filter((s) => s.state !== "done").length;

  return (
    // US-3032: h3 inside a <div>, not an h2 inside a <section>. These steps are
    // one part of the "Browser extension" section on Marketplaces now, beside
    // the queue, sold-sync and the per-channel disclosures.
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">
          Set up cross-posting
        </h3>
        {remaining === 0 ? (
          <Badge
            variant="outline"
            className="gap-1 border-emerald-300 bg-emerald-50 text-[10px] text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
          >
            <Check className="h-3 w-3" />
            Ready
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-1 text-[10px]">
            <Circle aria-hidden="true" className="h-1.5 w-1.5 fill-current" />
            {remaining} step{remaining === 1 ? "" : "s"} left
          </Badge>
        )}
        {state.version && (
          <span className="text-xs text-muted-foreground">v{state.version}</span>
        )}
      </div>
      {state.installed && !state.reachable && (
        <p className="mb-3 max-w-prose rounded-lg border border-dashed p-3 text-xs leading-relaxed text-muted-foreground">
          The extension is installed but did not answer. That usually means an
          older build — update it from your browser's extensions page, then
          reload this page.
        </p>
      )}
      <ol className="space-y-2">
        {steps.map((step, i) => (
          <StepRow key={step.key} step={step} index={i} />
        ))}
      </ol>
    </div>
  );
}
