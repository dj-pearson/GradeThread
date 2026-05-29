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
] as const;
