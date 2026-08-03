// Free "Will it fit me?" checker tool (US-1780): /tools/fit-checker.
//
// A no-signup tool that compares a garment's flat-lay measurements to your body
// measurements and returns a fit verdict. The computation is DETERMINISTIC and
// runs entirely CLIENT-SIDE (src/lib/fit-model.ts) — there is no endpoint and
// nothing is sent to the server, so anonymous use persists no PII beyond the
// browser (localStorage). Buyer-side trust bait that funnels shoppers into
// saving a profile + browsing certified items.
//
// PURE DATA: imports only the PublicRoute TYPE. JSON-LD composed in
// src/pages/marketing/marketing-jsonld.ts.

import type { PublicRoute } from "./public-routes";

export const FIT_CHECKER_PATH = "/tools/fit-checker";

export const FIT_CHECKER_META = {
  path: FIT_CHECKER_PATH,
  title: "Will It Fit Me? Free Clothing Fit Checker",
  description:
    "Free fit checker: enter a garment's flat measurements and your body measurements to see if it'll fit before you buy. No signup, nothing stored.",
  h1: "Will it fit me? Free clothing fit checker",
  intro:
    "Buying pre-owned online means guessing at fit from a size tag that may not match. Enter a garment's flat-lay measurements (the numbers a good listing shows) and your body measurements, and get an honest fit verdict — too small, slim, true, relaxed, or too big — plus the limiting dimension and a size recommendation. It runs entirely in your browser: no account, nothing sent anywhere, nothing stored beyond this device.",
  steps: [
    { name: "Pick the garment type", text: "Top, bottom, dress, or outerwear — this sets which measurements matter and the expected ease." },
    { name: "Enter the measurements", text: "The garment's flat measurements from the listing, and your body measurements. Switch inches/cm anytime." },
    { name: "Get an honest fit read", text: "A per-dimension and overall verdict with a size recommendation. It's an estimate — cut, fabric, and preference still matter." },
  ],
  faqs: [
    {
      q: "How do I know if clothes will fit before buying online?",
      a: "Compare the garment's flat-lay measurements to your body measurements. A flat chest measurement (pit to pit) doubled is the garment's chest circumference; compared to your chest circumference plus the ease a style needs, you can tell whether it'll be tight, true, or roomy. This free tool does that math per dimension and flags the limiting one — the measurement most likely to make it not fit.",
    },
    {
      q: "What are flat-lay measurements?",
      a: "Measurements taken with the garment laid flat: pit-to-pit for chest, flat waist, inseam, sleeve, and so on. Good resale listings publish them because they're objective — unlike a size tag, they don't vary by brand. Double the flat circumference measurements (chest, waist, hips) to compare against your body circumference.",
    },
    {
      q: "Is the fit checker accurate?",
      a: "It's a deterministic estimate from measurements and published ease tolerances — no black box. It can't account for fabric stretch, a garment's specific cut, or personal preference for a tighter or looser fit, so treat it as a strong starting point, not a guarantee. The tool tells you its confidence and which dimension is limiting.",
    },
    {
      q: "Do you store my body measurements?",
      a: "Not on our servers. The fit check runs entirely in your browser and nothing is sent anywhere. If you want to save your measurements for one-tap checks across items, you can create a free account — then they're stored privately to your account only.",
    },
  ],
};

export function fitCheckerRoute(): PublicRoute {
  return {
    path: FIT_CHECKER_PATH,
    title: FIT_CHECKER_META.title,
    description: FIT_CHECKER_META.description,
    changefreq: "monthly",
    priority: 0.7,
    jsonLdType: "WebApplication",
  };
}
