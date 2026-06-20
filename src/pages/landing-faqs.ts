// Landing-page FAQ content, in its own module so both the landing page and the
// build-time prerender head-builder (US-292) can import it without pulling the
// whole landing component into the prerender's module graph — and so landing.tsx
// stays a components-only file (react-refresh lint).

export const LANDING_FAQS = [
  {
    q: "How does AI grading work?",
    a: "You upload photos of your garment (front, back, label, and detail shots). Our Claude Vision AI analyzes the images across 5 weighted factors — Fabric Condition (30%), Structural Integrity (25%), Cosmetic Appearance (20%), Functional Elements (15%), and Odor & Cleanliness (10%) — to produce a standardized 1.0–10.0 grade.",
  },
  {
    q: "What if I disagree with a grade?",
    a: "You can file a dispute directly from the submission detail page. Include additional photos or notes explaining why you believe the grade should be different. Our team reviews disputes and can adjust grades when warranted.",
  },
  {
    q: "Can I use GradeThread for free?",
    a: "Yes. The Free plan includes 3 Standard grades per month at no cost, plus a 14-day free trial of Pro on signup (no card required). After that you can stay on Free, pay per grade, or subscribe to a paid tier.",
  },
  {
    q: "Do credits expire?",
    a: "No. Once you buy a credit pack, the credits stay in your account until you use them. There's no monthly minimum, no auto-debit, and no expiry date.",
  },
  {
    q: "Can I pause my subscription?",
    a: "Yes — for up to 3 months. While paused you keep all your data and credits, your caps fall back to Free, and we don't charge you. Resume any time.",
  },
  {
    q: "What happens to my listings if I downgrade?",
    a: "Your data stays intact. If you have more active listings than your new plan allows, the extras are hidden from active sync until you list them, end them, or upgrade again. Sub-accounts and API keys disable at period end.",
  },
  {
    q: "What types of clothing can I grade?",
    a: "GradeThread supports tops, bottoms, outerwear, dresses, footwear, and accessories. Each category has specific sub-types like t-shirts, jeans, jackets, sneakers, bags, and more.",
  },
  {
    q: "Are certificates publicly verifiable?",
    a: "Yes. Each certificate has a unique URL and QR code that anyone can use to verify the grade. Certificates display the overall score, tier, factor breakdown, and garment photos.",
  },
  {
    q: "Do you offer an API?",
    a: "Yes, the Business plan includes programmatic API access. You can integrate GradeThread grading directly into your own applications, inventory management systems, or listing tools.",
  },
  {
    q: "What is a Garment Passport?",
    a: "Every grade can carry a Garment Passport — a shareable, privacy-safe provenance timeline for the item. It records the grade, the listing, and ownership hand-offs over time, so a buyer can scan it before they buy and see the item's history. It carries forward when the garment is relisted or resold.",
  },
  {
    q: "What is a Verified Seller?",
    a: "Sellers who grade their inventory with GradeThread can build a public Verified Seller profile — ranked by graded volume and average condition grade and listed in our Verified Directory. The verified badge and stats can be embedded in your marketplace listings to build buyer trust.",
  },
  {
    q: "What does the Buyer Guarantee cover?",
    a: "The condition-backed Buyer Guarantee lets a buyer who receives an item materially not as graded file a mediation claim against the certificate. It's our commitment that a GradeThread grade means what it says — read the full terms on the Buyer Guarantee page.",
  },
  {
    q: "Can GradeThread help me list and price faster?",
    a: "Yes. FlipDesk's AutoLister turns photos into ready-to-publish, AI-written listings in bulk; ScoutAI pulls real sold comps so you price with data; and repricing rules plus scheduled drops keep prices moving and time your launches — all from one place.",
  },
  {
    q: "Does GradeThread support consignment?",
    a: "Yes. FlipDesk includes a consignment workflow — track consignors, calculate each consignor's split, and pay them out via Stripe Connect, reconciled against your real marketplace payouts.",
  },
  {
    q: "Is there a referral program?",
    a: "Yes. Share your referral link and earn grade credits when friends join and qualify. Top referrers appear on our public leaderboard.",
  },
] as const;
