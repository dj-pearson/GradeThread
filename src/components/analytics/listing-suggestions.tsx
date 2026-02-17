import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  Globe,
  DollarSign,
  Camera,
  X,
  ArrowRight,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type {
  InventoryItemRow,
  ListingRow,
  GradeReportRow,
} from "@/types/database";

export interface ListingSuggestion {
  id: string;
  type: "add_platforms" | "price_adjustment" | "regrade_photos";
  title: string;
  description: string;
  severity: "info" | "warning" | "urgent";
  itemId: string;
  itemTitle: string;
  actionLabel: string;
  actionRoute: string;
}

const DISMISSED_KEY = "gradethread_dismissed_suggestions";

function getDismissedSuggestions(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function saveDismissedSuggestion(id: string): void {
  const dismissed = getDismissedSuggestions();
  dismissed.add(id);
  localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissed]));
}

function getDaysListed(listing: ListingRow): number {
  const listedDate = new Date(listing.listed_at);
  const now = new Date();
  return Math.floor(
    (now.getTime() - listedDate.getTime()) / (1000 * 60 * 60 * 24)
  );
}

export function generateListingSuggestions(
  items: InventoryItemRow[],
  listings: ListingRow[],
  gradeReports: GradeReportRow[]
): ListingSuggestion[] {
  const suggestions: ListingSuggestion[] = [];
  const gradeMap = new Map(gradeReports.map((r) => [r.submission_id, r]));

  for (const item of items) {
    // Skip items that are sold/shipped/completed/returned
    if (
      item.status === "sold" ||
      item.status === "shipped" ||
      item.status === "completed" ||
      item.status === "returned"
    ) {
      continue;
    }

    const itemListings = listings.filter(
      (l) => l.inventory_item_id === item.id
    );
    const activeListings = itemListings.filter((l) => l.is_active);

    // Suggestion: "Add to more platforms" if only listed on 1 platform
    if (activeListings.length === 1) {
      const firstListing = activeListings[0];
      if (!firstListing) continue;
      const platform = firstListing.platform;
      suggestions.push({
        id: `add_platforms_${item.id}`,
        type: "add_platforms",
        title: "List on more platforms",
        description: `"${item.title}" is only listed on ${formatPlatform(platform)}. Cross-listing can increase visibility and speed up sales.`,
        severity: "info",
        itemId: item.id,
        itemTitle: item.title,
        actionLabel: "Add Listing",
        actionRoute: `/dashboard/inventory/${item.id}`,
      });
    }

    // Suggestion: "Consider price adjustment" based on time listed
    if (activeListings.length > 0) {
      const maxDays = Math.max(...activeListings.map(getDaysListed));
      if (maxDays > 14) {
        const severity =
          maxDays > 60 ? "urgent" : maxDays > 30 ? "warning" : "info";
        suggestions.push({
          id: `price_adjustment_${item.id}`,
          type: "price_adjustment",
          title: "Consider price adjustment",
          description: `"${item.title}" has been listed for ${maxDays} days without selling. ${maxDays > 60 ? "A significant price reduction or auction format may help." : maxDays > 30 ? "A 10-20% price reduction may attract buyers." : "A small price adjustment could increase visibility."}`,
          severity,
          itemId: item.id,
          itemTitle: item.title,
          actionLabel: "Review Pricing",
          actionRoute: `/dashboard/inventory/${item.id}`,
        });
      }
    }

    // Suggestion: "Re-grade with more photos" if grade confidence is low
    if (item.submission_id) {
      const report = gradeMap.get(item.submission_id);
      if (report && report.confidence_score < 0.75) {
        suggestions.push({
          id: `regrade_photos_${item.id}`,
          type: "regrade_photos",
          title: "Re-grade with more photos",
          description: `"${item.title}" has a low confidence score (${(report.confidence_score * 100).toFixed(0)}%). Adding detail or defect photos and re-grading could improve accuracy.`,
          severity: "warning",
          itemId: item.id,
          itemTitle: item.title,
          actionLabel: "New Submission",
          actionRoute: "/dashboard/submissions/new",
        });
      }
    }
  }

  // Sort: urgent first, then warning, then info
  const severityOrder = { urgent: 0, warning: 1, info: 2 };
  suggestions.sort(
    (a, b) => severityOrder[a.severity] - severityOrder[b.severity]
  );

  return suggestions;
}

function formatPlatform(platform: string): string {
  const labels: Record<string, string> = {
    ebay: "eBay",
    poshmark: "Poshmark",
    mercari: "Mercari",
    depop: "Depop",
    grailed: "Grailed",
    facebook: "Facebook Marketplace",
    offerup: "OfferUp",
    other: "Other",
  };
  return labels[platform] ?? platform;
}

const SUGGESTION_ICON = {
  add_platforms: Globe,
  price_adjustment: DollarSign,
  regrade_photos: Camera,
} as const;

const SEVERITY_STYLES = {
  urgent: {
    border: "border-l-red-500",
    bg: "bg-red-50",
    icon: "text-red-600",
    badge: "border-red-200 bg-red-100 text-red-800",
  },
  warning: {
    border: "border-l-yellow-500",
    bg: "bg-yellow-50",
    icon: "text-yellow-600",
    badge: "border-yellow-200 bg-yellow-100 text-yellow-800",
  },
  info: {
    border: "border-l-blue-500",
    bg: "bg-blue-50",
    icon: "text-blue-600",
    badge: "border-blue-200 bg-blue-100 text-blue-800",
  },
} as const;

interface ListingSuggestionsProps {
  items: InventoryItemRow[];
  listings: ListingRow[];
  gradeReports: GradeReportRow[];
  maxItems?: number;
}

export function ListingSuggestions({
  items,
  listings,
  gradeReports,
  maxItems,
}: ListingSuggestionsProps) {
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState<Set<string>>(
    getDismissedSuggestions
  );

  const allSuggestions = useMemo(
    () => generateListingSuggestions(items, listings, gradeReports),
    [items, listings, gradeReports]
  );

  const visibleSuggestions = useMemo(() => {
    const filtered = allSuggestions.filter((s) => !dismissed.has(s.id));
    return maxItems ? filtered.slice(0, maxItems) : filtered;
  }, [allSuggestions, dismissed, maxItems]);

  function handleDismiss(id: string) {
    saveDismissedSuggestion(id);
    setDismissed((prev) => new Set([...prev, id]));
  }

  if (visibleSuggestions.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Listing Optimization</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {visibleSuggestions.map((suggestion) => {
          const Icon = SUGGESTION_ICON[suggestion.type];
          const styles = SEVERITY_STYLES[suggestion.severity];

          return (
            <div
              key={suggestion.id}
              className={cn(
                "flex items-start gap-3 rounded-lg border-l-4 p-3",
                styles.border,
                styles.bg
              )}
            >
              <Icon
                className={cn("mt-0.5 h-4 w-4 shrink-0", styles.icon)}
              />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    {suggestion.title}
                  </span>
                  <Badge
                    variant="outline"
                    className={cn("text-[10px] px-1.5 py-0", styles.badge)}
                  >
                    {suggestion.severity}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {suggestion.description}
                </p>
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={() => navigate(suggestion.actionRoute)}
                >
                  {suggestion.actionLabel}
                  <ArrowRight className="ml-1 h-3 w-3" />
                </Button>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 shrink-0 p-0"
                onClick={() => handleDismiss(suggestion.id)}
              >
                <X className="h-3 w-3" />
                <span className="sr-only">Dismiss</span>
              </Button>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

interface InventoryItemSuggestionsProps {
  item: InventoryItemRow;
  listings: ListingRow[];
  gradeReport: GradeReportRow | null;
}

export function InventoryItemSuggestions({
  item,
  listings,
  gradeReport,
}: InventoryItemSuggestionsProps) {
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState<Set<string>>(
    getDismissedSuggestions
  );

  const suggestions = useMemo(
    () =>
      generateListingSuggestions(
        [item],
        listings,
        gradeReport ? [gradeReport] : []
      ),
    [item, listings, gradeReport]
  );

  const visible = suggestions.filter((s) => !dismissed.has(s.id));

  function handleDismiss(id: string) {
    saveDismissedSuggestion(id);
    setDismissed((prev) => new Set([...prev, id]));
  }

  if (visible.length === 0) return null;

  return (
    <>
      {visible.map((suggestion) => {
        const Icon = SUGGESTION_ICON[suggestion.type];
        const styles = SEVERITY_STYLES[suggestion.severity];

        return (
          <Card
            key={suggestion.id}
            className={cn("border-l-4", styles.border, styles.bg)}
          >
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center justify-between text-base">
                <span className="flex items-center gap-2">
                  <Icon className={cn("h-4 w-4", styles.icon)} />
                  {suggestion.title}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  onClick={() => handleDismiss(suggestion.id)}
                >
                  <X className="h-3 w-3" />
                  <span className="sr-only">Dismiss</span>
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 text-sm">
                <p>{suggestion.description}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => navigate(suggestion.actionRoute)}
                >
                  {suggestion.actionLabel}
                  <ArrowRight className="ml-1 h-3 w-3" />
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </>
  );
}
