// Size and measurement conversion (US-9007), behind /tools/measurement-converter.
//
// TWO HALVES WITH VERY DIFFERENT CONFIDENCE, and the page has to say so.
//
// 1. Length conversion is exact. One inch is 2.54 cm by definition, and the
//    flat-to-worn doubling for circumference measurements is arithmetic. Nothing
//    here is a judgement call.
//
// 2. International size conversion is APPROXIMATE and always will be. There is
//    no standards body; every brand cuts to its own block, vanity sizing moves
//    the numbers a full size in either direction, and a US 8 from two labels can
//    differ by two inches in the waist. The tables below are the widely
//    published correspondences, useful for narrowing down and useless as a
//    guarantee. The tool leads with the measurement, not the label, which is the
//    whole reason a measurement converter is worth building at all.
//
// Measurement keys and labels come from MEASUREMENT_SPECS so this cannot drift
// away from what MeasureCard collects (US-9007 AC2).

import {
  MEASUREMENT_SPECS,
  isCircumferenceMeasurement,
  type LengthUnit,
} from "./measurements";

const IN_TO_CM = 2.54;

/** Exact. Rounded to 2dp so a round-trip does not accumulate float noise. */
export function convertLength(value: number, from: LengthUnit, to: LengthUnit): number {
  if (!Number.isFinite(value)) return NaN;
  if (from === to) return round2(value);
  return round2(from === "in" ? value * IN_TO_CM : value / IN_TO_CM);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The worn number for a garment measured flat. A chest measured pit to pit on a
 * flat garment is half the circumference the body has to fit through, which is
 * the single most common misreading of a listing.
 */
export function flatToWorn(key: string, flat: number): number {
  return isCircumferenceMeasurement(key) ? round2(flat * 2) : round2(flat);
}

/** How and where to take each measurement. Keyed to MEASUREMENT_SPECS. */
export interface MeasurementHowTo {
  key: string;
  /** Label, taken from MEASUREMENT_SPECS so the two cannot disagree. */
  label: string;
  /** Where to put the tape, in one sentence. */
  how: string;
  /** The mistake people make on this one. */
  pitfall: string;
}

export const MEASUREMENT_HOWTO: readonly MeasurementHowTo[] = [
  {
    key: "chest",
    label: MEASUREMENT_SPECS.chest.label,
    how: "Lay the garment flat, fasten it, and measure straight across from one armpit seam to the other.",
    pitfall:
      "This is half the chest, not the whole chest. A 21 inch pit to pit fits a 42 inch chest. Doubling it is the step most buyers skip.",
  },
  {
    key: "length",
    label: MEASUREMENT_SPECS.length.label,
    how: "From the highest point of the shoulder seam, next to the collar, straight down to the hem.",
    pitfall:
      "Measuring from the back collar seam instead of the shoulder gives a shorter number, and the two are not interchangeable between listings.",
  },
  {
    key: "shoulder",
    label: MEASUREMENT_SPECS.shoulder.label,
    how: "Across the back, from the seam where one sleeve joins the body to the same seam on the other side.",
    pitfall:
      "On a dropped-shoulder or oversized cut this number says almost nothing about fit. Use chest and length instead.",
  },
  {
    key: "sleeve",
    label: MEASUREMENT_SPECS.sleeve.label,
    how: "From the shoulder seam down the outside of the arm to the cuff.",
    pitfall:
      "Raglan sleeves have no shoulder seam. Measure from the centre back collar instead and say that you did.",
  },
  {
    key: "waist",
    label: MEASUREMENT_SPECS.waist.label,
    how: "Lay flat, smooth the waistband, and measure straight across from edge to edge.",
    pitfall:
      "Another half measurement. A 16 inch flat waist is a 32 inch waist. Stretch waistbands should be measured relaxed, with the stretched number given separately.",
  },
  {
    key: "hip",
    label: MEASUREMENT_SPECS.hip.label,
    how: "Flat, across the widest point below the waistband, usually 7 to 9 inches down.",
    pitfall: "Measuring at the pocket line rather than the widest point understates it.",
  },
  {
    key: "inseam",
    label: MEASUREMENT_SPECS.inseam.label,
    how: "From the crotch seam straight down the inside leg to the hem.",
    pitfall:
      "Cuffed hems must be unrolled first, or the listing understates the inseam by an inch or two.",
  },
  {
    key: "rise",
    label: MEASUREMENT_SPECS.rise.label,
    how: "From the crotch seam up to the top of the waistband at the front.",
    pitfall:
      "Rise is what decides whether jeans sit at the hip or the waist, and it is the number most often left out.",
  },
  {
    key: "leg_opening",
    label: MEASUREMENT_SPECS.leg_opening.label,
    how: "Flat, straight across the hem at the bottom of the leg.",
    pitfall: "Half measurement again. Double it for the opening the foot has to pass through.",
  },
];

// ---------------------------------------------------------------------------
// International sizing. APPROXIMATE. See the note at the top of this file.
// ---------------------------------------------------------------------------

/** The basis line the page must render next to every size table. */
export const SIZE_TABLE_CAVEAT =
  "Approximate. No standards body governs clothing sizes, brands cut to their own blocks, and vanity sizing moves the numbers by a full size in either direction. Use these to narrow down, then check the garment measurements, which are the only numbers that mean the same thing everywhere.";

export interface WomensSize {
  us: string;
  uk: string;
  eu: string;
  jp: string;
  alpha: string;
  /** Approximate body bust, inches. */
  bustIn: string;
  /** Approximate body waist, inches. */
  waistIn: string;
}

export const WOMENS_SIZES: readonly WomensSize[] = [
  { us: "0", uk: "4", eu: "32", jp: "5", alpha: "XXS", bustIn: "31-32", waistIn: "24-25" },
  { us: "2", uk: "6", eu: "34", jp: "7", alpha: "XS", bustIn: "32-33", waistIn: "25-26" },
  { us: "4", uk: "8", eu: "36", jp: "9", alpha: "S", bustIn: "33-34", waistIn: "26-27" },
  { us: "6", uk: "10", eu: "38", jp: "11", alpha: "S", bustIn: "34-35", waistIn: "27-28" },
  { us: "8", uk: "12", eu: "40", jp: "13", alpha: "M", bustIn: "35-36", waistIn: "28-29" },
  { us: "10", uk: "14", eu: "42", jp: "15", alpha: "M", bustIn: "36-38", waistIn: "29-31" },
  { us: "12", uk: "16", eu: "44", jp: "17", alpha: "L", bustIn: "38-40", waistIn: "31-33" },
  { us: "14", uk: "18", eu: "46", jp: "19", alpha: "L", bustIn: "40-42", waistIn: "33-35" },
  { us: "16", uk: "20", eu: "48", jp: "21", alpha: "XL", bustIn: "42-44", waistIn: "35-37" },
  { us: "18", uk: "22", eu: "50", jp: "23", alpha: "XL", bustIn: "44-46", waistIn: "37-39" },
  { us: "20", uk: "24", eu: "52", jp: "25", alpha: "XXL", bustIn: "46-48", waistIn: "39-41" },
];

export interface MensTopSize {
  alpha: string;
  /** Body chest, inches. The number the EU and UK figures derive from. */
  chestIn: string;
  /** UK and US menswear share a numeric chest sizing. */
  ukUs: string;
  eu: string;
  jp: string;
  /** Collar size for dress shirts, inches. */
  neckIn: string;
}

export const MENS_TOP_SIZES: readonly MensTopSize[] = [
  { alpha: "XS", chestIn: "32-34", ukUs: "34", eu: "44", jp: "S", neckIn: "14-14.5" },
  { alpha: "S", chestIn: "35-37", ukUs: "36", eu: "46", jp: "M", neckIn: "15" },
  { alpha: "M", chestIn: "38-40", ukUs: "40", eu: "50", jp: "L", neckIn: "15.5-16" },
  { alpha: "L", chestIn: "41-43", ukUs: "42", eu: "52", jp: "XL", neckIn: "16.5-17" },
  { alpha: "XL", chestIn: "44-46", ukUs: "46", eu: "56", jp: "XXL", neckIn: "17.5-18" },
  // EU 60 and 64, not 58 and 62. The derivation test below caught both: a 48
  // inch chest is 122 cm, and half of that is 61, so a 58 here was three sizes
  // adrift at the top of the range where big-and-tall buyers live.
  { alpha: "XXL", chestIn: "47-49", ukUs: "48", eu: "60", jp: "3XL", neckIn: "18.5-19" },
  { alpha: "3XL", chestIn: "50-52", ukUs: "52", eu: "64", jp: "4XL", neckIn: "19.5-20" },
];

/**
 * European menswear jacket sizing is roughly the body chest in centimetres
 * halved, which is why EU 50 lands on a 39 inch chest. Exposed so the page can
 * show the derivation rather than presenting the table as folklore.
 */
export function mensChestInchesToEu(chestIn: number): number {
  if (!Number.isFinite(chestIn)) return NaN;
  return Math.round((chestIn * IN_TO_CM) / 2);
}

export interface ShoeSize {
  usMen: string;
  usWomen: string;
  uk: string;
  eu: string;
  jp: string;
  /** Foot length, centimetres. The only one of these that is a measurement. */
  footCm: string;
}

export const SHOE_SIZES: readonly ShoeSize[] = [
  { usMen: "4", usWomen: "5.5", uk: "3.5", eu: "36", jp: "22.5", footCm: "22.5" },
  { usMen: "5", usWomen: "6.5", uk: "4.5", eu: "37", jp: "23.5", footCm: "23.5" },
  { usMen: "6", usWomen: "7.5", uk: "5.5", eu: "38.5", jp: "24", footCm: "24" },
  { usMen: "7", usWomen: "8.5", uk: "6.5", eu: "40", jp: "25", footCm: "25" },
  { usMen: "8", usWomen: "9.5", uk: "7.5", eu: "41", jp: "26", footCm: "26" },
  { usMen: "9", usWomen: "10.5", uk: "8.5", eu: "42.5", jp: "27", footCm: "27" },
  { usMen: "10", usWomen: "11.5", uk: "9.5", eu: "44", jp: "28", footCm: "28" },
  { usMen: "11", usWomen: "12.5", uk: "10.5", eu: "45", jp: "29", footCm: "29" },
  { usMen: "12", usWomen: "13.5", uk: "11.5", eu: "46", jp: "30", footCm: "30" },
  { usMen: "13", usWomen: "14.5", uk: "12.5", eu: "47.5", jp: "31", footCm: "31" },
];

/**
 * US shoe sizing runs 1.5 sizes apart between the men's and women's scales, so
 * a men's 8 and a women's 9.5 are the same shoe. This is the one cross-gender
 * conversion that is close to reliable, because both scales are cut from the
 * same last length.
 */
export const MENS_TO_WOMENS_SHOE_OFFSET = 1.5;

export function mensToWomensShoe(usMen: number): number {
  return Number.isFinite(usMen) ? usMen + MENS_TO_WOMENS_SHOE_OFFSET : NaN;
}

export function womensToMensShoe(usWomen: number): number {
  return Number.isFinite(usWomen) ? usWomen - MENS_TO_WOMENS_SHOE_OFFSET : NaN;
}

/**
 * Men's to women's TOPS, which is a much weaker correspondence than shoes and is
 * labelled as such wherever it is shown. The garments are cut differently
 * through the shoulder, chest and waist, so this maps the label only, and the
 * fit may still be wrong at the "correct" size.
 */
export const MENS_TO_WOMENS_TOP: readonly { mens: string; womens: string }[] = [
  { mens: "XS", womens: "S" },
  { mens: "S", womens: "M" },
  { mens: "M", womens: "L" },
  { mens: "L", womens: "XL" },
  { mens: "XL", womens: "XXL" },
  { mens: "XXL", womens: "3XL" },
];

export const MENS_TO_WOMENS_TOP_CAVEAT =
  "Weaker than the shoe conversion, and worth treating with suspicion. Men's and women's tops are cut differently through the shoulder, chest and waist, so this maps the label, not the fit. Compare the pit to pit and the shoulder before buying.";

/** Look up a row by any of its size values, for the converter's search input. */
export function findWomensSize(system: keyof WomensSize, value: string): WomensSize | undefined {
  const v = value.trim().toLowerCase();
  return WOMENS_SIZES.find((s) => String(s[system]).toLowerCase() === v);
}

export function findShoeSize(system: keyof ShoeSize, value: string): ShoeSize | undefined {
  const v = value.trim().toLowerCase();
  return SHOE_SIZES.find((s) => String(s[system]).toLowerCase() === v);
}
