import { Link } from "react-router";
import { LegalLayout } from "@/components/legal/legal-layout";

// Third-party marketplace names appear throughout GradeThread and FlipDesk.
// This page is the single, findable place that (a) attributes each mark to its
// owner, (b) disclaims endorsement, and (c) states HONESTLY which platforms we
// actually reach through a licensed API and which we only name.
//
// The API/no-API split here MUST stay in sync with MARKETPLACE_TIER and
// MARKETPLACE_MECHANISM in src/lib/constants.ts. Only tier "api" belongs in the
// licensed-API section; claiming API use for a platform we have no agreement
// with is a false statement about that company, which is worse than saying
// nothing at all.

export function TrademarksPage() {
  return (
    <LegalLayout
      title="Trademarks & Third-Party Notices"
      description="Trademark attribution and non-endorsement notices for the marketplaces named in GradeThread and FlipDesk, and the platforms we reach via a licensed API."
      canonicalPath="/trademarks"
      effectiveDate="August 10, 2026"
    >
      <p>
        GradeThread and FlipDesk are products of Pearson Media LLC. We are an
        independent company. We are not affiliated with, endorsed by, sponsored
        by, or certified by any of the marketplaces named on this page or
        anywhere else in our products, marketing, or documentation.
      </p>

      <h2 id="how-we-use-names">1. Why these names appear at all</h2>
      <p>
        Our software helps sellers list and track pre-owned clothing across
        marketplaces. To do that we have to name those marketplaces, the same
        way a road atlas has to name the cities on it. Every reference is
        descriptive: it identifies a company, a website, or a feature of that
        website so you know where your listing is going.
      </p>
      <p>
        All product names, logos, brands, and trademarks are the property of
        their respective owners. Use of a name does not imply any relationship
        between that owner and Pearson Media LLC.
      </p>

      <h2 id="licensed-apis">2. Platforms we integrate with through an API</h2>
      <p>
        We hold developer access to the following platforms and use their public
        APIs under their developer terms. Even so, neither has reviewed,
        approved, or endorsed our products.
      </p>
      <ul>
        <li>
          <strong>eBay</strong> is a trademark of eBay Inc. This application
          uses the eBay API but is not endorsed or certified by eBay Inc.
        </li>
        <li>
          <strong>Shopify</strong> is a trademark of Shopify Inc. This
          application uses the Shopify API but is not endorsed or certified by
          Shopify Inc.
        </li>
      </ul>

      <h2 id="extension-platforms">3. Platforms reached through your own browser</h2>
      <p>
        Our optional browser extension helps you fill in a listing form on a
        marketplace you are already signed in to, in your own browser session.
        It does not use those companies' APIs, does not connect to them on your
        behalf, and does not give us access to your account with them.
      </p>
      <ul>
        <li>
          <strong>Poshmark</strong> is a trademark of Poshmark, Inc. This
          application is not endorsed or certified by Poshmark, Inc.
        </li>
        <li>
          <strong>Mercari</strong> is a trademark of Mercari, Inc. This
          application is not endorsed or certified by Mercari, Inc.
        </li>
        <li>
          <strong>Grailed</strong> is a trademark of Grailed, Inc. This
          application is not endorsed or certified by Grailed, Inc.
        </li>
        <li>
          <strong>Vinted</strong> is a trademark of Vinted UAB. This application
          is not endorsed or certified by Vinted UAB.
        </li>
      </ul>

      <h2 id="named-only">4. Platforms we name but do not integrate with</h2>
      <p>
        These marketplaces appear in our software so you can record where an
        item was sourced or sold, compare marketplaces, or read a guide. We do
        not use their APIs and we have no integration with them.
      </p>
      <ul>
        <li>
          <strong>Depop</strong> is a trademark of Depop Limited. This
          application is not endorsed or certified by Depop Limited.
        </li>
        <li>
          <strong>Etsy</strong> is a trademark of Etsy, Inc. This application is
          not endorsed or certified by Etsy, Inc.
        </li>
        <li>
          <strong>Whatnot</strong> is a trademark of Whatnot Inc. This
          application is not endorsed or certified by Whatnot Inc.
        </li>
        <li>
          <strong>Facebook</strong> and <strong>Facebook Marketplace</strong>{" "}
          are trademarks of Meta Platforms, Inc. This application is not
          endorsed or certified by Meta Platforms, Inc.
        </li>
        <li>
          <strong>OfferUp</strong> is a trademark of OfferUp Inc. This
          application is not endorsed or certified by OfferUp Inc.
        </li>
      </ul>
      <p>
        Where a connector for one of these platforms exists in our code but is
        switched off pending that platform's approval, our Marketplaces screen
        labels it as such. We do not advertise a channel as available before it
        is.
      </p>

      <h2 id="other-third-parties">5. Other third-party names</h2>
      <p>
        We also name service providers we genuinely rely on, including Stripe
        (Stripe, Inc.), Google and Google Sheets (Google LLC), Apple and the App
        Store (Apple Inc.), and Anthropic and Claude (Anthropic PBC). Each mark
        belongs to its owner. Our{" "}
        <Link to="/subprocessors">Subprocessors</Link> page lists the providers
        that process personal data for us.
      </p>

      <h2 id="brand-assets">6. Logos and brand assets</h2>
      <p>
        We use third-party marks as plain words, not as logos. We do not display
        another company's logo, wordmark artwork, or brand imagery without that
        company's written permission, and we do not use another company's name
        in our product names, our domain names, our app names, or our app icons.
      </p>

      <h2 id="our-marks">7. Our own marks</h2>
      <p>
        GradeThread, FlipDesk, and the GradeThread logo are trademarks of
        Pearson Media LLC. Our certificates, badges, and embeddable grade
        widgets may be displayed by sellers and marketplaces in connection with
        a genuine, unaltered GradeThread grade. Any other use requires our
        written permission. See our{" "}
        <Link to="/terms">Terms of Service</Link> for the full licence.
      </p>

      <h2 id="report">8. Questions or corrections</h2>
      <p>
        If you own one of these marks and believe a reference on our site or in
        our software is inaccurate, misleading, or inconsistent with your brand
        guidelines, email{" "}
        <a href="mailto:legal@gradethread.com">legal@gradethread.com</a> and we
        will correct or remove it promptly. Copyright complaints go to our{" "}
        <Link to="/dmca">Copyright / DMCA</Link> page.
      </p>
    </LegalLayout>
  );
}
