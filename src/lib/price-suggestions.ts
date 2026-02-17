import type {
  InventoryItemRow,
  ListingRow,
  SaleRow,
} from "@/types/database";

export interface PriceSuggestion {
  suggestedPrice: number | null;
  currentPrice: number | null;
  adjustmentPercent: number | null;
  reason: string;
  severity: "info" | "warning" | "urgent";
  action: string;
}

interface SalesHistoryItem {
  item: InventoryItemRow;
  sale: SaleRow;
  grade?: number | null;
}

function getGradeTierMultiplier(grade: number): number {
  if (grade >= 9.5) return 1.3; // NWT
  if (grade >= 8.5) return 1.2; // NWOT
  if (grade >= 7.5) return 1.1; // Excellent
  if (grade >= 6.5) return 1.0; // Very Good
  if (grade >= 5.5) return 0.9; // Good
  if (grade >= 4.5) return 0.75; // Fair
  return 0.6; // Poor
}

function getDaysListed(listing: ListingRow): number {
  const listedDate = new Date(listing.listed_at);
  const now = new Date();
  return Math.floor((now.getTime() - listedDate.getTime()) / (1000 * 60 * 60 * 24));
}

function getOldestActiveDaysListed(listings: ListingRow[]): number {
  const activeListings = listings.filter((l) => l.is_active);
  if (activeListings.length === 0) return 0;
  return Math.max(...activeListings.map(getDaysListed));
}

function getAverageSalePrice(
  salesHistory: SalesHistoryItem[],
  item: InventoryItemRow,
  grade: number | null
): number | null {
  // Filter for similar items: same category or brand
  const similar = salesHistory.filter((h) => {
    const sameCategory =
      item.garment_category &&
      h.item.garment_category === item.garment_category;
    const sameBrand =
      item.brand && h.item.brand && h.item.brand.toLowerCase() === item.brand!.toLowerCase();
    return sameCategory || sameBrand;
  });

  if (similar.length === 0) return null;

  // Weight by grade similarity if available
  if (grade !== null) {
    const withGrades = similar.filter((h) => h.grade != null);
    if (withGrades.length >= 3) {
      // Use grade-weighted average: closer grades get more weight
      let totalWeight = 0;
      let weightedSum = 0;
      for (const h of withGrades) {
        const gradeDiff = Math.abs((h.grade ?? 5) - grade);
        const weight = Math.max(0.1, 1 - gradeDiff / 10);
        weightedSum += h.sale.sale_price * weight;
        totalWeight += weight;
      }
      if (totalWeight > 0) return weightedSum / totalWeight;
    }
  }

  // Simple average
  const avg =
    similar.reduce((sum, h) => sum + h.sale.sale_price, 0) / similar.length;
  return avg;
}

export function calculateSuggestedPrice(
  item: InventoryItemRow,
  grade: number | null,
  listings: ListingRow[],
  salesHistory: SalesHistoryItem[]
): PriceSuggestion {
  const activeListings = listings.filter((l) => l.is_active);
  const currentPrice =
    activeListings.length > 0
      ? Math.max(...activeListings.map((l) => l.listing_price))
      : null;

  const daysListed = getOldestActiveDaysListed(listings);

  // Get comparable average
  const avgSalePrice = getAverageSalePrice(salesHistory, item, grade);

  // Base suggestion: use average sale price adjusted by grade, or current price
  let basePrice: number | null = null;
  if (avgSalePrice !== null && grade !== null) {
    basePrice = avgSalePrice * getGradeTierMultiplier(grade);
  } else if (avgSalePrice !== null) {
    basePrice = avgSalePrice;
  } else if (currentPrice !== null) {
    basePrice = currentPrice;
  }

  // Apply time-based adjustments
  if (daysListed > 60) {
    const reduction = currentPrice
      ? currentPrice * 0.25
      : basePrice
        ? basePrice * 0.25
        : null;
    const suggestedPrice = currentPrice
      ? Math.round((currentPrice * 0.75) * 100) / 100
      : basePrice
        ? Math.round((basePrice * 0.75) * 100) / 100
        : null;

    return {
      suggestedPrice,
      currentPrice,
      adjustmentPercent: -25,
      reason: `Listed for ${daysListed} days. Consider a 20-30% price reduction or auction format.${reduction ? "" : ""}`,
      severity: "urgent",
      action: "Reduce price significantly or consider auction",
    };
  }

  if (daysListed > 30) {
    const suggestedPrice = currentPrice
      ? Math.round((currentPrice * 0.85) * 100) / 100
      : basePrice
        ? Math.round((basePrice * 0.85) * 100) / 100
        : null;

    return {
      suggestedPrice,
      currentPrice,
      adjustmentPercent: -15,
      reason: `Listed for ${daysListed} days. A 10-20% price reduction may help attract buyers.`,
      severity: "warning",
      action: "Consider moderate price reduction",
    };
  }

  if (daysListed > 14) {
    const suggestedPrice = currentPrice
      ? Math.round((currentPrice * 0.93) * 100) / 100
      : basePrice
        ? Math.round((basePrice * 0.93) * 100) / 100
        : null;

    return {
      suggestedPrice,
      currentPrice,
      adjustmentPercent: -7,
      reason: `Listed for ${daysListed} days. A small 5-10% reduction could increase visibility.`,
      severity: "info",
      action: "Consider slight price reduction",
    };
  }

  // No time pressure — suggest based on comparable data
  if (basePrice !== null && currentPrice !== null) {
    const diff = basePrice - currentPrice;
    const percentDiff = Math.round((diff / currentPrice) * 100);

    if (Math.abs(percentDiff) > 5) {
      return {
        suggestedPrice: Math.round(basePrice * 100) / 100,
        currentPrice,
        adjustmentPercent: percentDiff,
        reason:
          percentDiff > 0
            ? `Based on similar items, you may be able to price ${percentDiff}% higher.`
            : `Based on similar items, your price is ${Math.abs(percentDiff)}% above average.`,
        severity: percentDiff < -15 ? "warning" : "info",
        action:
          percentDiff > 0 ? "Consider raising price" : "Consider lowering price",
      };
    }
  }

  // Price looks fine
  return {
    suggestedPrice: basePrice ? Math.round(basePrice * 100) / 100 : null,
    currentPrice,
    adjustmentPercent: null,
    reason:
      currentPrice !== null
        ? "Your current price looks competitive based on available data."
        : "No active listings. List this item to start tracking.",
    severity: "info",
    action: currentPrice !== null ? "No changes needed" : "Create a listing",
  };
}
