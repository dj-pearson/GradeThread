import { ShieldAlert, Loader2, FileText, ArrowDownToLine } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { CopyField } from "@/components/verified/copy-field";
import { AnnotatedPhoto } from "@/components/disclosure/annotated-photo";
import {
  useDisclosure,
  useApplyDisclosure,
  useSetAnnotationOptIn,
} from "@/hooks/use-disclosure";

// Auto-Disclosure Engine surface for a graded FlipDesk item: the documented
// "Condition & Flaws" section (copy / add to listing) + AI-annotated defect
// photos. A documented, AI-verified disclosure is the strongest defense against
// "item not as described" disputes and lifts buyer confidence/conversion.

export function DisclosurePanel({ itemId }: { itemId: string }) {
  const { data, isLoading } = useDisclosure(itemId);
  const apply = useApplyDisclosure(itemId);
  const annotationOptIn = useSetAnnotationOptIn(itemId);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-48" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!data || !data.graded || !data.disclosure) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="h-5 w-5 text-brand-navy dark:text-foreground" />
            Condition Disclosure
          </CardTitle>
          <CardDescription>
            Grade this item and we write up its condition and every flaw, with
            the flaws marked on photos.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const { disclosure, grade, photos } = data;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="h-5 w-5 text-brand-navy dark:text-foreground" />
          Condition Disclosure
          {grade && (
            <Badge variant="outline" className="ml-1">
              {grade.grade_tier} · {grade.overall_score.toFixed(1)}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          {disclosure.has_defects
            ? `${disclosure.defect_count} documented flaw${disclosure.defect_count === 1 ? "" : "s"} — auto-disclose to cut "not as described" disputes.`
            : "No significant flaws detected — disclose the clean bill of health."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Condition & Flaws text */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <FileText className="h-4 w-4 text-muted-foreground" />
            Condition &amp; Flaws
          </div>
          <pre className="whitespace-pre-wrap rounded-md border bg-muted px-3 py-2 text-xs leading-relaxed">
            {disclosure.plain}
          </pre>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => apply.mutate()}
              disabled={apply.isPending}
              size="sm"
            >
              {apply.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <ArrowDownToLine className="mr-1.5 h-4 w-4" />
              )}
              Add to listing description
            </Button>
          </div>
        </div>

        {/* Copyable HTML block for marketplaces that aren't eBay */}
        <CopyField
          label="HTML (paste into any listing description)"
          value={disclosure.html}
          multiline
        />

        {disclosure.style_features.length > 0 && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium">Design features (not flaws):</span>{" "}
            {disclosure.style_features.join(", ")}. Graded as styling, not damage.
          </p>
        )}

        {/* US-538: per-item opt-in — AutoLister attaches the annotated photos
            automatically when it generates this item's listing. */}
        {disclosure.has_defects && (
          <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
            <div className="space-y-0.5">
              <div className="text-sm font-medium">
                Auto-attach in AutoLister
              </div>
              <p className="text-xs text-muted-foreground">
                When AutoLister writes this listing, it marks each flaw on a
                photo and adds those photos for you.
              </p>
            </div>
            <Switch
              checked={data.item?.annotate_defect_photos === true}
              onCheckedChange={(v) => annotationOptIn.mutate(v)}
              disabled={annotationOptIn.isPending}
              aria-label="Auto-attach annotated defect photos in AutoLister"
            />
          </div>
        )}

        {/* Annotated defect photos */}
        {photos && photos.length > 0 && (
          <div className="space-y-3">
            <div className="text-sm font-medium">Annotated defect photos</div>
            <p className="text-xs text-muted-foreground">
              Numbered callouts mark each flaw, stamped with your certificate
              number. Download or attach them to your listing so buyers see
              exactly what they're getting.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              {photos.map((p) => (
                <AnnotatedPhoto
                  key={p.image_type}
                  photo={p}
                  itemId={itemId}
                  // US-2567: the same stamp the AutoLister worker burns in, so
                  // this preview is the artifact rather than a rehearsal of it.
                  stamp={data?.grade
                    ? {
                      certificateNumber: data.grade.certificate_number ?? null,
                      overallScore: data.grade.overall_score,
                      gradeTier: data.grade.grade_tier,
                    }
                    : null}
                />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
