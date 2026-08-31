// RN number lookup tool (US-9033): /tools/rn-lookup.
//
// The 2026-08-31 tool-noun pull put `rn number lookup` and `rn number search`
// at 5,000/mo each on Low competition with a top-of-page bid of zero — no
// advertiser wants it and no SaaS is defending it. It is also a NAMED TOOL,
// which the 2026-08-28 SERP audit found is the query shape that still returns
// ten blue links rather than an AI Overview.
//
// The page answers with a company name, and earns the visit with the tag
// reader: photograph the care label and the same AI pass the AutoLister uses
// pulls out the RN, size, fabric and style code.
//
// PURE DATA: imports only the PublicRoute TYPE.

import type { PublicRoute } from "./public-routes";

export const RN_LOOKUP_PATH = "/tools/rn-lookup";

/** The unauthenticated edge endpoints (joined to edgeApiUrl() at call time). */
export const TAG_READ_ENDPOINT = "/api/grading/public/tag-read";
export const RN_LOOKUP_ENDPOINT = "/api/content/public/registered-numbers";

export const RN_LOOKUP_META = {
  path: RN_LOOKUP_PATH,
  title: "RN Number Lookup — Find Who Made a Garment",
  description:
    "Free RN number lookup. Type the RN from a clothing care label to find the company that made or imported it, or photograph the tag and we will read the number, size and fabric for you.",
  h1: "RN number lookup",
  intro:
    "Every clothing label sold in the US can carry an RN — a Registered Identification Number issued by the FTC to the company that made, imported, distributed or sold the item. Type it in to find that company. An RN names the company, never the brand on the tag, and because it is public a counterfeit can print a real one, so treat a match as corroboration rather than proof.",
  steps: [
    {
      name: "Find the number on the label",
      text: "Look at the care label, usually beside the fabric content. It reads RN followed by two to seven digits. Canadian labels print CA and a different registry.",
    },
    {
      name: "Look it up, or photograph the tag",
      text: "Type the digits, or drop a photo of the label and we will read the RN, the size, the fabric content and the style code off it.",
    },
    {
      name: "Read what it does and does not prove",
      text: "You get the registered company and the brands it labels. One company often covers several brands, so the number narrows it to the maker, not the label.",
    },
  ],
  faqs: [
    {
      q: "What is an RN number on clothing?",
      a: "RN stands for Registered Identification Number. The US Federal Trade Commission issues one to a business that manufactures, imports, distributes or sells textile, wool or fur products, and the business may print it on the label in place of its company name.",
    },
    {
      q: "Does an RN number prove a garment is real?",
      a: "No. RNs are public and searchable, so a counterfeiter can print a genuine one on a fake label. A matching RN is corroboration alongside the stitching, the tag generation and the materials — never proof on its own.",
    },
    {
      q: "Why does the RN name a company I have never heard of?",
      a: "An RN belongs to the registered business, not the brand. One company often labels several brands, and plenty of well-known labels are made under a parent company's registration.",
    },
    {
      q: "What is a CA number?",
      a: "A CA number is the Canadian equivalent, issued under Canada's textile labelling rules. We read and answer them, but our index is built around the US register.",
    },
    {
      q: "Where does your data come from?",
      a: "The FTC's public RN database. Every company name we show links back to the FTC record it came from, so you can check us.",
    },
  ],
} as const;

export function rnLookupRoute(): PublicRoute {
  return {
    path: RN_LOOKUP_PATH,
    title: RN_LOOKUP_META.title,
    description: RN_LOOKUP_META.description,
    changefreq: "monthly",
    priority: 0.7,
    jsonLdType: "WebApplication",
  };
}
