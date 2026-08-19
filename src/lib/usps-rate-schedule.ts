// The USPS rate schedule the public shipping calculator runs on (US-9004).
//
// EVERY NUMBER WAS TAKEN FROM A PUBLISHED RATE SHEET AND CROSS-CHECKED AGAINST
// A SECOND SOURCE. The tables come from Pirate Ship's published USPS rate
// workbook (PirateShip-August-8-2026-USPS-Rates.xlsx, "Ground Advantage
// Weight-Based", "Priority Mail Weight-Based" and "Priority Mail Flat Rate"
// sheets); the same figures were then read back off USPS Notice 123 at
// pe.usps.com. The two agree to the cent on every value that was spot-checked,
// including all eight zones at 1 lb and 2 lb and all seven flat-rate products.
// The working is recorded in docs/seo/usps-rate-schedule-CONFIRMED.csv.
//
// US-9003 shipped a fee schedule whose first draft had 13.25% for apparel — a
// real eBay number belonging to a different category. The rule that came out of
// it applies here too: nothing in this file may be edited from memory or from a
// secondary source, and a second source has to agree before a number lands.
//
// WHICH PRICE TIER THIS IS, stated plainly because it is the thing a seller can
// most easily be misled about: these are USPS COMMERCIAL prices, the tier you
// pay when you buy a label through eBay, Pirate Ship, Stamps.com or any other
// online provider. They are not Post Office counter (retail) prices, which run
// roughly 30-40% higher. eBay's own label rates are at or below this tier, so a
// result here is a ceiling on what an eBay label costs, not a quote.
//
// WHY THE TABLE IS STATIC AND DATED rather than a carrier API call (AC2): the
// page prerenders, and a third-party outage must not be able to break it. The
// cost of that choice is staleness, which is why USPS_RATES_EFFECTIVE_FROM is
// shown on the page rather than buried here.

/** The day these prices took effect. Shown on the page. */
export const USPS_RATES_EFFECTIVE_FROM = "2026-08-08";

/** The day the tables were read and cross-checked. Shown on the page. */
export const USPS_RATES_RETRIEVED_ON = "2026-08-18";

export type UspsZone = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/**
 * USPS zone bands by distance. USPS assigns zones from a per-prefix chart
 * rather than raw mileage, so treating them as distance bands is an
 * approximation — accurate in the middle of a band, and capable of being one
 * zone out near a boundary. The calculator says so rather than implying a
 * lookup it did not do.
 */
export const ZONE_BANDS: ReadonlyArray<{ zone: UspsZone; maxMiles: number; label: string }> = [
  { zone: 1, maxMiles: 50, label: "0-50 miles" },
  { zone: 2, maxMiles: 150, label: "51-150 miles" },
  { zone: 3, maxMiles: 300, label: "151-300 miles" },
  { zone: 4, maxMiles: 600, label: "301-600 miles" },
  { zone: 5, maxMiles: 1000, label: "601-1,000 miles" },
  { zone: 6, maxMiles: 1400, label: "1,001-1,400 miles" },
  { zone: 7, maxMiles: 1800, label: "1,401-1,800 miles" },
  { zone: 8, maxMiles: Infinity, label: "1,801+ miles" },
];

/**
 * Ground Advantage under 1 lb, by zone. ONE price per zone, because USPS
 * removed the 4 oz and 8 oz commercial tiers on 2026-07-12. Note that it is
 * CHEAPER than the 1 lb row: a package that creeps from 15.9 oz to 16.1 oz
 * costs more, which is the single most avoidable mistake in clothing postage.
 */
export const GROUND_ADVANTAGE_UNDER_1LB: readonly number[] = [6.93, 6.94, 7.3, 7.46, 7.69, 7.86, 8.07, 8.4];

/** Ground Advantage commercial, 1-70 lb, zones 1-8. Index 0 is 1 lb. */
export const GROUND_ADVANTAGE_BY_POUND: ReadonlyArray<readonly number[]> = [
  [7.61, 7.68, 8.0, 8.15, 8.74, 9.63, 9.98, 10.67], // 1 lb
  [7.99, 8.08, 8.26, 8.51, 9.95, 11.58, 12.0, 12.87], // 2 lb
  [8.64, 8.66, 9.14, 9.67, 11.57, 13.59, 14.36, 15.75], // 3 lb
  [9.28, 9.34, 9.7, 10.65, 12.84, 15.16, 16.19, 18.01], // 4 lb
  [9.7, 9.76, 10.14, 11.02, 13.48, 15.89, 17.12, 19.19], // 5 lb
  [9.87, 9.94, 10.36, 11.55, 14.28, 16.89, 18.31, 20.68], // 6 lb
  [9.96, 10.02, 10.62, 11.9, 14.9, 17.65, 19.23, 21.83], // 7 lb
  [10.1, 10.27, 11.49, 12.43, 15.49, 18.34, 20.08, 22.9], // 8 lb
  [11.01, 11.25, 12.39, 13.65, 16.11, 19.13, 21.01, 24.09], // 9 lb
  [11.91, 12.26, 13.18, 14.44, 16.76, 19.94, 21.97, 25.34], // 10 lb
  [12.75, 12.94, 14.0, 15.18, 18.12, 21.28, 23.68, 27.37], // 11 lb
  [13.49, 13.85, 14.63, 15.89, 18.86, 22.2, 24.78, 28.73], // 12 lb
  [14.15, 14.48, 15.25, 16.53, 19.62, 23.16, 25.87, 30.11], // 13 lb
  [14.73, 15.07, 15.81, 17.13, 20.38, 24.14, 26.99, 31.53], // 14 lb
  [15.23, 15.53, 16.31, 17.67, 21.15, 25.13, 28.11, 32.91], // 15 lb
  [15.64, 15.91, 16.73, 17.94, 21.89, 26.09, 29.22, 34.29], // 16 lb
  [15.97, 16.29, 17.15, 18.41, 22.51, 26.85, 30.11, 35.42], // 17 lb
  [16.21, 16.46, 17.61, 18.94, 23.16, 27.7, 31.09, 36.64], // 18 lb
  [16.38, 16.82, 17.81, 19.36, 23.79, 28.52, 32.07, 37.84], // 19 lb
  [16.46, 17.06, 18.03, 19.66, 24.93, 30.32, 34.67, 40.39], // 20 lb
  [18.48, 19.54, 20.66, 21.79, 26.13, 31.69, 37.96, 43.01], // 21 lb
  [19.86, 21.22, 22.59, 24.07, 29.45, 36.73, 44.33, 49.74], // 22 lb
  [21.51, 23.16, 24.92, 27.33, 34.05, 43.29, 52.14, 58.41], // 23 lb
  [23.44, 25.27, 27.64, 31.62, 39.94, 51.28, 61.4, 68.97], // 24 lb
  [25.32, 27.54, 30.72, 36.6, 46.94, 58.24, 68.86, 78.19], // 25 lb
  [26.27, 28.68, 32.26, 39.07, 50.46, 61.73, 72.61, 82.8], // 26 lb
  [27.21, 29.84, 33.81, 41.58, 53.96, 65.24, 76.35, 87.46], // 27 lb
  [27.97, 30.7, 34.85, 42.85, 55.75, 67.49, 79.02, 90.53], // 28 lb
  [28.72, 31.55, 35.87, 44.11, 57.53, 69.69, 81.65, 93.58], // 29 lb
  [29.46, 32.38, 36.86, 45.34, 59.28, 71.88, 84.24, 96.6], // 30 lb
  [30.18, 33.22, 37.84, 46.55, 61.0, 74.02, 86.8, 99.57], // 31 lb
  [30.9, 34.04, 38.8, 47.73, 62.68, 76.13, 89.33, 102.51], // 32 lb
  [31.62, 34.84, 39.75, 48.88, 64.39, 78.24, 91.83, 105.42], // 33 lb
  [32.32, 35.65, 40.68, 50.04, 66.04, 80.3, 94.29, 108.29], // 34 lb
  [33.04, 36.43, 41.61, 51.18, 67.69, 82.37, 96.77, 111.16], // 35 lb
  [33.71, 37.21, 42.51, 52.25, 69.26, 84.33, 99.14, 113.94], // 36 lb
  [34.41, 37.99, 43.41, 53.35, 70.86, 86.32, 101.54, 116.74], // 37 lb
  [35.08, 38.75, 44.28, 54.44, 72.44, 88.31, 103.9, 119.51], // 38 lb
  [35.77, 39.5, 45.13, 55.49, 74.0, 90.27, 106.22, 122.25], // 39 lb
  [36.44, 40.24, 45.98, 56.54, 75.51, 92.17, 108.52, 124.96], // 40 lb
  [37.09, 40.98, 46.81, 57.59, 77.04, 94.08, 110.8, 127.62], // 41 lb
  [37.76, 41.68, 47.62, 58.59, 78.52, 95.94, 113.05, 130.28], // 42 lb
  [38.4, 42.4, 48.44, 59.57, 79.98, 97.79, 115.27, 132.88], // 43 lb
  [39.05, 43.09, 49.2, 60.54, 81.41, 99.6, 117.45, 135.45], // 44 lb
  [39.68, 43.78, 49.99, 61.5, 82.85, 101.39, 119.61, 138.01], // 45 lb
  [40.33, 44.45, 50.75, 62.42, 84.23, 103.17, 121.75, 140.52], // 46 lb
  [40.94, 45.12, 51.49, 63.33, 85.6, 104.9, 123.82, 143.0], // 47 lb
  [41.56, 45.78, 52.22, 64.22, 86.97, 106.61, 125.9, 145.45], // 48 lb
  [42.17, 46.42, 52.92, 65.1, 88.3, 108.29, 127.94, 147.88], // 49 lb
  [42.77, 47.07, 53.63, 65.96, 89.6, 109.94, 129.95, 150.27], // 50 lb
  [43.35, 47.71, 54.29, 66.79, 90.88, 111.57, 131.92, 152.63], // 51 lb
  [43.95, 48.31, 54.95, 67.61, 92.15, 113.18, 133.86, 154.95], // 52 lb
  [44.53, 48.92, 55.61, 68.4, 93.38, 114.75, 135.79, 157.25], // 53 lb
  [45.1, 49.51, 56.25, 69.18, 94.61, 116.31, 137.67, 159.49], // 54 lb
  [45.67, 50.1, 56.85, 69.95, 95.8, 117.84, 139.53, 161.74], // 55 lb
  [46.22, 50.67, 57.47, 70.7, 96.98, 119.32, 141.35, 163.93], // 56 lb
  [46.79, 51.24, 58.05, 71.42, 98.11, 120.81, 143.15, 166.1], // 57 lb
  [47.33, 51.78, 58.62, 72.11, 99.24, 122.23, 144.91, 168.23], // 58 lb
  [47.88, 52.34, 59.18, 72.81, 100.35, 123.67, 146.64, 170.33], // 59 lb
  [48.39, 52.87, 59.71, 73.46, 101.42, 125.04, 148.35, 172.39], // 60 lb
  [48.92, 53.4, 60.24, 74.12, 102.48, 126.41, 150.02, 174.44], // 61 lb
  [49.45, 53.89, 60.76, 74.74, 103.51, 127.76, 151.66, 176.44], // 62 lb
  [49.95, 54.41, 61.25, 75.34, 104.53, 129.07, 153.28, 178.42], // 63 lb
  [50.46, 54.9, 61.73, 75.93, 105.53, 130.35, 154.87, 180.36], // 64 lb
  [50.94, 55.38, 62.19, 76.51, 106.49, 131.6, 156.42, 182.25], // 65 lb
  [51.44, 55.85, 62.63, 77.06, 107.43, 132.83, 157.93, 184.13], // 66 lb
  [51.93, 56.3, 63.06, 77.6, 108.35, 134.04, 159.44, 185.98], // 67 lb
  [52.41, 56.76, 63.49, 78.11, 109.25, 135.22, 160.9, 187.79], // 68 lb
  [52.88, 57.2, 63.87, 78.61, 110.13, 136.34, 162.33, 189.57], // 69 lb
  [53.33, 57.63, 64.26, 79.08, 110.97, 137.46, 163.73, 191.31], // 70 lb
];

/** Priority Mail commercial, 1-70 lb, zones 1-8. Index 0 is 1 lb. */
export const PRIORITY_MAIL_BY_POUND: ReadonlyArray<readonly number[]> = [
  [9.04, 9.32, 9.71, 10.4, 12.97, 14.47, 15.08, 15.22], // 1 lb
  [9.1, 9.39, 9.78, 10.79, 13.17, 15.34, 16.31, 16.37], // 2 lb
  [9.45, 9.71, 10.75, 12.68, 16.56, 18.86, 20.51, 20.57], // 3 lb
  [10.97, 11.22, 12.52, 14.96, 19.88, 24.51, 26.76, 26.82], // 4 lb
  [11.39, 11.56, 13.02, 15.72, 21.52, 26.35, 29.1, 29.18], // 5 lb
  [11.77, 11.84, 13.44, 16.46, 23.07, 28.16, 31.35, 31.9], // 6 lb
  [12.19, 12.38, 13.96, 17.46, 24.89, 30.28, 33.99, 34.97], // 7 lb
  [12.48, 12.6, 14.91, 17.97, 25.91, 31.5, 35.6, 37.15], // 8 lb
  [13.5, 13.63, 15.84, 18.78, 26.84, 32.63, 37.1, 39.25], // 9 lb
  [14.5, 14.63, 16.66, 19.62, 27.78, 33.74, 38.57, 41.28], // 10 lb
  [15.43, 15.56, 17.52, 20.43, 29.45, 35.4, 40.78, 44.05], // 11 lb
  [16.28, 16.39, 18.21, 21.25, 30.62, 36.76, 42.54, 46.25], // 12 lb
  [17.03, 17.15, 18.93, 22.1, 31.99, 38.3, 44.45, 48.54], // 13 lb
  [17.74, 17.87, 19.65, 22.96, 33.51, 40.02, 46.59, 51], // 14 lb
  [18.39, 18.52, 20.37, 23.91, 35.25, 41.99, 48.97, 53.6], // 15 lb
  [19.01, 19.13, 21.1, 24.68, 37.23, 44.19, 51.61, 56.4], // 16 lb
  [19.56, 19.69, 21.93, 25.82, 39.36, 46.5, 54.4, 59.22], // 17 lb
  [20.09, 20.21, 22.93, 27.17, 41.89, 49.26, 57.68, 62.42], // 18 lb
  [20.36, 20.48, 23.19, 27.75, 43.03, 50.58, 59.36, 64.47], // 19 lb
  [20.56, 20.69, 23.54, 28.29, 44.81, 53.02, 62.83, 68.06], // 20 lb
  [22.3, 22.93, 25.94, 31.08, 47.75, 57.77, 69.07, 76.4], // 21 lb
  [24.03, 25.15, 28.33, 33.89, 50.68, 62.52, 75.31, 84.73], // 22 lb
  [25.77, 27.39, 30.73, 36.69, 53.63, 67.26, 81.54, 93.06], // 23 lb
  [27.5, 29.61, 33.11, 39.5, 56.57, 72.01, 87.78, 101.39], // 24 lb
  [29.24, 31.85, 35.51, 42.29, 59.51, 76.77, 94.01, 109.73], // 25 lb
  [30.33, 33.17, 37.3, 45.15, 63.96, 83.72, 103.47, 121.13], // 26 lb
  [31.43, 34.48, 39.1, 48.05, 68.4, 86.96, 105.53, 123.92], // 27 lb
  [32.31, 35.5, 40.28, 49.51, 70.66, 89.12, 107.57, 126.84], // 28 lb
  [33.16, 36.48, 41.46, 50.94, 72.91, 91.27, 109.61, 129.43], // 29 lb
  [34.03, 37.45, 42.63, 52.38, 75.15, 93.4, 111.65, 131.81], // 30 lb
  [34.86, 38.43, 43.76, 53.77, 77.32, 95.52, 113.7, 134.3], // 31 lb
  [35.7, 39.38, 44.88, 55.14, 79.48, 97.62, 115.74, 136.61], // 32 lb
  [36.55, 40.33, 46, 56.52, 81.6, 99.68, 117.77, 139.03], // 33 lb
  [37.37, 41.25, 47.08, 57.83, 83.73, 101.78, 119.83, 141.43], // 34 lb
  [38.18, 42.17, 48.14, 59.15, 85.81, 103.84, 121.88, 143.67], // 35 lb
  [39, 43.07, 49.19, 60.45, 87.84, 105.79, 123.71, 146.03], // 36 lb
  [39.78, 43.98, 50.23, 61.72, 89.88, 107.72, 125.56, 148.36], // 37 lb
  [40.56, 44.83, 51.24, 62.96, 91.85, 109.6, 127.34, 150.69], // 38 lb
  [41.36, 45.72, 52.23, 64.18, 93.82, 111.72, 129.63, 152.99], // 39 lb
  [42.13, 46.57, 53.22, 65.39, 95.75, 113.78, 131.8, 155.26], // 40 lb
  [42.9, 47.42, 54.17, 66.57, 97.65, 115.81, 133.96, 157.59], // 41 lb
  [43.66, 48.24, 55.12, 67.73, 99.52, 117.69, 135.86, 159.81], // 42 lb
  [44.41, 49.06, 56.05, 68.86, 101.37, 119.56, 137.72, 161.95], // 43 lb
  [45.15, 49.86, 56.95, 69.98, 103.18, 121.38, 139.59, 164.24], // 44 lb
  [45.89, 50.67, 57.84, 71.1, 104.98, 123.18, 141.39, 166.47], // 45 lb
  [46.6, 51.45, 58.73, 72.15, 106.73, 124.98, 143.22, 168.66], // 46 lb
  [47.34, 52.22, 59.56, 73.21, 108.48, 126.77, 145.07, 170.87], // 47 lb
  [48.05, 52.98, 60.43, 74.23, 110.17, 128.52, 146.86, 173.03], // 48 lb
  [48.74, 53.74, 61.24, 75.24, 111.86, 130.27, 148.67, 175.15], // 49 lb
  [49.44, 54.48, 62.05, 76.23, 113.49, 132.04, 150.6, 177.34], // 50 lb
  [50.12, 55.21, 62.81, 77.18, 115.11, 133.84, 152.57, 179.47], // 51 lb
  [50.8, 55.9, 63.57, 78.13, 116.69, 135.65, 154.58, 181.69], // 52 lb
  [51.47, 56.61, 64.32, 79.05, 118.25, 137.45, 156.66, 183.99], // 53 lb
  [52.13, 57.29, 65.07, 79.93, 119.78, 139.23, 158.67, 186.35], // 54 lb
  [52.78, 57.97, 65.76, 80.82, 121.28, 141.02, 160.75, 188.68], // 55 lb
  [53.44, 58.63, 66.46, 81.67, 122.74, 142.74, 162.75, 190.88], // 56 lb
  [54.08, 59.29, 67.13, 82.51, 124.21, 144.33, 164.44, 192.91], // 57 lb
  [54.69, 59.93, 67.8, 83.31, 125.61, 145.94, 166.26, 195.04], // 58 lb
  [55.32, 60.57, 68.44, 84.1, 127, 147.48, 167.96, 197.1], // 59 lb
  [55.93, 61.18, 69.07, 84.87, 128.36, 149.02, 169.66, 199.11], // 60 lb
  [56.54, 61.79, 69.65, 85.61, 129.69, 150.64, 171.58, 201.52], // 61 lb
  [57.13, 62.39, 70.24, 86.32, 130.98, 152.26, 173.52, 204.06], // 62 lb
  [57.72, 62.96, 70.82, 87.02, 132.26, 153.72, 175.18, 206.57], // 63 lb
  [58.3, 63.54, 71.38, 87.7, 133.5, 155.15, 176.81, 209.09], // 64 lb
  [58.87, 64.1, 71.91, 88.35, 134.71, 156.59, 178.46, 211.57], // 65 lb
  [59.44, 64.62, 72.42, 88.98, 135.9, 157.96, 180.03, 214.14], // 66 lb
  [59.97, 65.16, 72.91, 89.6, 137.05, 159.34, 181.62, 216.53], // 67 lb
  [60.53, 65.69, 73.41, 90.19, 138.18, 160.74, 183.28, 218.83], // 68 lb
  [61.08, 66.19, 73.86, 90.76, 139.29, 162.11, 184.93, 221.13], // 69 lb
  [61.6, 66.7, 74.29, 91.3, 140.36, 163.45, 186.53, 223.46], // 70 lb
];

export interface FlatRateOption {
  key: string;
  name: string;
  price: number;
  /** Usable inside dimensions in inches, as USPS states them. */
  fits: string;
  /**
   * Usable interior, as numbers, for the fit test. An ARRAY of shapes: the
   * Medium Flat Rate Box is sold in a top-loading and a side-loading form with
   * genuinely different interiors, and a package that will not go in one goes
   * in the other. Fitting any listed shape counts as fitting.
   */
  interiors: ReadonlyArray<readonly [number, number, number]>;
  /** What a clothing seller actually gets in it. */
  holds: string;
}

/**
 * Priority Mail Flat Rate, commercial. Weight is irrelevant up to 70 lb and so
 * is the zone, which is exactly why it wins on heavy or far-travelling packages
 * and loses on light local ones.
 */
export const FLAT_RATE_OPTIONS: readonly FlatRateOption[] = [
  {
    key: "envelope",
    name: "Flat Rate Envelope",
    price: 11.12,
    interiors: [[12.5, 9.5, 0.75]],
    fits: '12.5" x 9.5"',
    holds: "A folded t-shirt or a pair of shorts, flattened. Not a hoodie.",
  },
  {
    key: "legal-envelope",
    name: "Legal Flat Rate Envelope",
    price: 11.66,
    interiors: [[15, 9.5, 0.75]],
    fits: '15" x 9.5"',
    holds: "The same, with room for a longer fold. Jeans fit if you roll them.",
  },
  {
    key: "padded-envelope",
    name: "Padded Flat Rate Envelope",
    price: 11.99,
    interiors: [[12.5, 9.5, 1]],
    fits: '12.5" x 9.5"',
    holds: "A sweatshirt or thin jacket. The padding costs you interior room.",
  },
  {
    key: "small-box",
    name: "Small Flat Rate Box",
    price: 12.1,
    interiors: [[8.6, 5.4, 1.6]],
    fits: '8.6" x 5.4" x 1.6"',
    holds: "Shoes will not fit. Belts, hats, folded knitwear will.",
  },
  {
    key: "medium-box",
    name: "Medium Flat Rate Box",
    price: 21.17,
    interiors: [
      [11, 8.5, 5.5],
      [13.6, 11.9, 3.4],
    ],
    fits: '11" x 8.5" x 5.5" or 13.6" x 11.9" x 3.4"',
    holds: "A boxed pair of sneakers, or two or three folded garments.",
  },
  {
    key: "large-box",
    name: "Large Flat Rate Box",
    price: 31.0,
    interiors: [[12, 12, 5.5]],
    fits: '12" x 12" x 5.5"',
    holds: "A winter coat, or a multi-item bundle.",
  },
];

/** Dimensional weight divisor. USPS lowered it from 166 on 2026-07-12. */
export const DIM_DIVISOR = 139;

/** Dimensional weight applies only above one cubic foot. */
export const DIM_THRESHOLD_CUBIC_INCHES = 1728;

export const MAX_BILLABLE_POUNDS = 70;

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

export interface PackageInput {
  /** Actual weight in ounces. */
  weightOz: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
}

export interface BillableWeight {
  /** Actual weight, in pounds, rounded up as USPS bills it. */
  actualLb: number;
  /** Dimensional weight in pounds, or null when the package is under a cubic foot. */
  dimLb: number | null;
  /** The one USPS charges on. */
  billableLb: number;
  /** True when dim weight beat actual weight, which is the case sellers miss. */
  dimApplies: boolean;
  cubicInches: number;
}

/**
 * USPS rounds every fractional dimension up to the next whole inch before it
 * measures anything (rule change of 2026-07-12), so a 10.2 inch box is an 11
 * inch box. Applied first, because it changes both the cubic-foot test and the
 * dimensional weight itself.
 */
export function roundDimension(inches: number): number {
  return Math.ceil(Math.max(inches, 0));
}

export function billableWeight(pkg: PackageInput): BillableWeight {
  const l = roundDimension(pkg.lengthIn);
  const w = roundDimension(pkg.widthIn);
  const h = roundDimension(pkg.heightIn);
  const cubicInches = l * w * h;

  const actualLb = Math.max(1, Math.ceil(pkg.weightOz / 16));

  // Under one cubic foot USPS does not look at the dimensions at all.
  const dimLb =
    cubicInches > DIM_THRESHOLD_CUBIC_INCHES ? Math.ceil(cubicInches / DIM_DIVISOR) : null;

  const billableLb = dimLb !== null && dimLb > actualLb ? dimLb : actualLb;
  return { actualLb, dimLb, billableLb, dimApplies: dimLb !== null && dimLb > actualLb, cubicInches };
}

/** Great-circle miles between two points. */
function haversineMiles(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 3958.8;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export interface ZoneEstimate {
  zone: UspsZone;
  miles: number;
  band: string;
}

/**
 * Estimated zone between two ZIP codes. Returns null when either ZIP prefix is
 * not a real one, which is a better answer than defaulting to Zone 1 and
 * quoting a price nobody will pay.
 */
export function estimateZone(
  originZip: string,
  destZip: string,
  centroid: (prefix: string) => { lat: number; lon: number } | null,
): ZoneEstimate | null {
  const a = centroid(originZip.trim().slice(0, 3));
  const b = centroid(destZip.trim().slice(0, 3));
  if (!a || !b) return null;
  const miles = haversineMiles(a, b);
  const band = ZONE_BANDS.find((z) => miles <= z.maxMiles) ?? ZONE_BANDS[ZONE_BANDS.length - 1]!;
  return { zone: band.zone, miles: Math.round(miles), band: band.label };
}

function lookup(
  table: ReadonlyArray<readonly number[]>,
  pounds: number,
  zone: UspsZone,
): number | null {
  const row = table[Math.min(pounds, MAX_BILLABLE_POUNDS) - 1];
  if (!row) return null;
  const price = row[zone - 1];
  return price ?? null;
}

export interface ServiceQuote {
  key: string;
  name: string;
  price: number;
  /** Delivery estimate as USPS states it, not a promise. */
  speed: string;
  /** Set when the quote ignores weight and zone. */
  flatRate?: FlatRateOption;
  /** Why this one is or is not usable, when there is something to say. */
  note?: string;
}

export interface ShippingQuote {
  weight: BillableWeight;
  zone: UspsZone;
  services: ServiceQuote[];
  cheapest: ServiceQuote | null;
  /** The cheapest option that is NOT flat rate, for the comparison line. */
  cheapestWeightBased: ServiceQuote | null;
  /** The cheapest flat-rate box or envelope, if any can hold the package. */
  cheapestFlatRate: ServiceQuote | null;
}

/**
 * A flat-rate container is only an option if the package actually fits inside
 * it, and volume alone does not answer that: a 30 inch garment tube has less
 * volume than a Small Flat Rate Box and fits in none of them. So the test is
 * per dimension, longest against longest.
 *
 * NOTE this uses the RAW dimensions, not the rounded-up ones. Rounding up is a
 * postage rule, not a physical one, and applying it here would stop the Medium
 * Flat Rate Box from fitting its own stated interior.
 */
function flatRateFits(option: FlatRateOption, pkg: PackageInput): boolean {
  const item = [pkg.lengthIn, pkg.widthIn, pkg.heightIn].sort((a, b) => b - a);
  return option.interiors.some((shape) => {
    const box = [...shape].sort((a, b) => b - a);
    return item.every((d, i) => d <= box[i]! + 1e-9);
  });
}

export function quoteShipping(pkg: PackageInput, zone: UspsZone): ShippingQuote {
  const weight = billableWeight(pkg);
  const services: ServiceQuote[] = [];

  // Ground Advantage: the sub-pound row only applies when ACTUAL weight is
  // under a pound AND dimensional weight has not taken over.
  const gaUnderPound =
    pkg.weightOz < 16 && !weight.dimApplies ? GROUND_ADVANTAGE_UNDER_1LB[zone - 1] : undefined;
  const ga = gaUnderPound ?? lookup(GROUND_ADVANTAGE_BY_POUND, weight.billableLb, zone);
  if (ga !== null && ga !== undefined) {
    services.push({
      key: "ground-advantage",
      name: "USPS Ground Advantage",
      price: ga,
      speed: "2-5 business days",
      note:
        gaUnderPound !== undefined
          ? "Under 1 lb, which is its own price and cheaper than the 1 lb rate."
          : undefined,
    });
  }

  const pm = lookup(PRIORITY_MAIL_BY_POUND, weight.billableLb, zone);
  if (pm !== null) {
    services.push({
      key: "priority-mail",
      name: "USPS Priority Mail",
      price: pm,
      speed: "1-3 business days",
    });
  }

  for (const option of FLAT_RATE_OPTIONS) {
    if (!flatRateFits(option, pkg)) continue;
    services.push({
      key: `flat-${option.key}`,
      name: `Priority Mail ${option.name}`,
      price: option.price,
      speed: "1-3 business days",
      flatRate: option,
      note: "Same price to any zone, up to 70 lb.",
    });
  }

  services.sort((a, b) => a.price - b.price);
  const cheapestWeightBased = services.find((s) => !s.flatRate) ?? null;
  const cheapestFlatRate = services.find((s) => s.flatRate) ?? null;
  return {
    weight,
    zone,
    services,
    cheapest: services[0] ?? null,
    cheapestWeightBased,
    cheapestFlatRate,
  };
}
