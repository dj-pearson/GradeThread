// US-1846: the buyer platform's legally-sensitive surfaces, and what holds each
// one honest.
//
// The buyer product sells confidence, which means several of its surfaces make
// claims a court would read as claims: "these photos look edited", "this looks
// genuine", "you're covered". Two of them already shipped fail-closed behind an
// operator kill-switch pending legal review (US-1771, US-1836) and the rest
// carry a fixed, server-authored limitations disclosure. Both postures were
// sound; neither was written down anywhere, so nobody could answer "which buyer
// copy still needs a lawyer, and what stops it shipping meanwhile?" without
// re-reading the routes.
//
// This is that answer, and buyer-legal-surfaces.test.ts makes it load-bearing:
//
//   kill-switch → the named env flag must be compared against "true" in the
//     named file, which is the shape that DEFAULTS OFF. A flag read as
//     `!== "false"` would be a gate that ships open, and reads almost the same.
//   disclaimer  → every required phrase must actually be present in the file
//     that authors the copy. A disclosure nobody asserts is a disclosure that
//     survives exactly until someone tightens the wording.
//
// What this file deliberately does NOT hold is a `reviewed: true` boolean. No
// code change can establish that a human read something, and a flag claiming it
// did would be worse than no flag. The kill-switch entries below ARE the
// pending-review list; the operator who flips one is the record that it
// happened.
//
// Contract: vault/20-domain/buyer-legal-and-privacy.md

/**
 * FAIL-CLOSED behind an operator env flag until the copy is legal-reviewed.
 * `enforcedIn` is the repo-relative file that reads the flag.
 */
export interface KillSwitchPosture {
  kind: "kill-switch";
  envFlag: string;
  enforcedIn: string;
}

/**
 * Live, held honest by a fixed disclosure the model cannot author.
 * `authoredIn` is the repo-relative file the phrases must appear in.
 */
export interface DisclaimerPosture {
  kind: "disclaimer";
  phrases: string[];
  authoredIn: string;
}

export type BuyerLegalPosture = KillSwitchPosture | DisclaimerPosture;

export interface BuyerLegalSurface {
  key: string;
  /** The claim the surface makes, stated as a buyer would hear it. */
  claim: string;
  posture: BuyerLegalPosture;
}

export const BUYER_LEGAL_SURFACES: readonly BuyerLegalSurface[] = [
  {
    key: "public_authenticity_check",
    claim: "This item looks genuine / shows red flags — said to an anonymous visitor.",
    posture: {
      kind: "kill-switch",
      envFlag: "PUBLIC_AUTHENTICITY_CHECK_ENABLED",
      enforcedIn: "services/edge-functions/src/routes/public-grading.ts",
    },
  },
  {
    key: "extension_fraud_flags",
    claim: "These listing photos show possible signs of editing or reuse.",
    posture: {
      kind: "kill-switch",
      envFlag: "EXTENSION_FRAUD_FLAGS_ENABLED",
      enforcedIn: "services/edge-functions/src/routes/public-grading.ts",
    },
  },
  {
    key: "authenticity_estimate",
    claim: "An authenticity confidence read on a buyer's own item (paid add-on).",
    posture: {
      kind: "disclaimer",
      // Verbatim fragments of AUTHENTICITY_LIMITATIONS — the disclosure that
      // travels with every verdict, on every surface that renders one.
      phrases: [
        "AI authenticity-confidence estimate",
        "not a definitive authentication, legal opinion, or guarantee",
        "one trust signal, not proof",
      ],
      authoredIn: "services/edge-functions/src/lib/ai-authenticity.ts",
    },
  },
  {
    key: "purchase_guarantee_coverage",
    claim: "This purchase is covered if it arrives materially worse than graded.",
    posture: {
      kind: "disclaimer",
      // The coverage page states the terms it is actually bound by. "You're
      // covered" without them is a promise wider than the engine enforces —
      // and the engine's terms are SNAPSHOTTED per purchase, which is the part
      // a buyer would never guess.
      phrases: [
        "not insurance",
        "terms that applied when you linked the purchase",
      ],
      authoredIn: "src/pages/buyer/guarantee.tsx",
    },
  },
];
