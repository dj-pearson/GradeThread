// Free "Is it authentic?" checker tool (US-1771): /tools/authenticity-check.
//
// A no-signup tool that gives an AI authenticity ESTIMATE from photos of an
// item's tags/logo/stitching — buyer-side trust bait that funnels shoppers into
// GradeThread. The tool posts to the unauthenticated edge endpoint
// /api/grading/public/authenticity-check (the grounded authenticity pass,
// US-1769), which is itself FAIL-CLOSED behind PUBLIC_AUTHENTICITY_CHECK_ENABLED
// until legal review. The output is ALWAYS framed as an estimate, never a
// guarantee, with the mandatory limitations disclaimer.
//
// PURE DATA: imports only the PublicRoute TYPE. JSON-LD composed in
// src/pages/marketing/marketing-jsonld.ts.

import type { PublicRoute } from "./public-routes";

export const AUTHENTICITY_CHECK_PATH = "/tools/authenticity-check";

/** The unauthenticated edge endpoint path (joined to edgeApiUrl() at call time). */
export const AUTHENTICITY_CHECK_ENDPOINT = "/api/grading/public/authenticity-check";

export const AUTHENTICITY_CHECK_META = {
  path: AUTHENTICITY_CHECK_PATH,
  title: "Free Brand Authenticity Checker for Clothing",
  description:
    "Free AI authenticity check: upload photos of an item's label, logo, and stitching for an independent estimate of whether it looks genuine. No signup.",
  h1: "Is it authentic? Free brand authenticity checker",
  intro:
    "Shopping pre-owned designer or premium clothing? Upload clear photos of the item's brand label, logo, hardware, and stitching, and get an independent GradeThread read on how consistent it looks with a genuine example — no account, no cost. This is an AI ESTIMATE from photos, not a definitive authentication, legal opinion, or guarantee: it can't inspect materials in person or catch a high-quality counterfeit. Treat it as one trust signal before you buy.",
  steps: [
    { name: "Photograph the tells", text: "Capture the brand/main label, any logos, hardware (zippers, buttons), and close-up stitching — the details that separate genuine from fake." },
    { name: "Upload up to four photos", text: "The authenticity pass checks the item against known, structured brand tells and returns a confidence-capped read: likely authentic, inconclusive, or red flags." },
    { name: "Buy with more confidence", text: "Use the estimate as one signal — and get a full certified GradeThread grade with a shareable certificate when you list your own items." },
  ],
  faqs: [
    {
      q: "Can you tell if clothing is authentic from a photo?",
      a: "Only partly. This tool gives an AI estimate of how consistent the visible logos, labels, stitching, and hardware are with a genuine example of the claimed brand. It cannot inspect materials in person, verify serial numbers, or reliably catch a high-quality counterfeit, so it's a confidence signal — not proof or a legal opinion.",
    },
    {
      q: "Is the authenticity checker a guarantee?",
      a: "No. It is explicitly an estimate, confidence-capped and disclaimer-bounded. GradeThread never issues an unqualified 'authentic' verdict from photos alone. For high-value items, use it alongside seller reputation, return policies, and in-person inspection.",
    },
    {
      q: "Which photos work best for an authenticity check?",
      a: "Clear, well-lit close-ups of the brand/main label (including any size, RN/CA, and care tags), the logo or embroidery, hardware like zipper pulls and buttons, and the stitching. Those carry most of the authenticity signal.",
    },
    {
      q: "Do I need an account to check authenticity?",
      a: "No. The free checker takes a few photos and returns an estimate with no signup. You only need an account when you want a full certified condition grade and a shareable certificate for items you're selling.",
    },
  ],
};

export function authenticityCheckRoute(): PublicRoute {
  return {
    path: AUTHENTICITY_CHECK_PATH,
    title: AUTHENTICITY_CHECK_META.title,
    description: AUTHENTICITY_CHECK_META.description,
    changefreq: "monthly",
    priority: 0.7,
    jsonLdType: "WebApplication",
  };
}
