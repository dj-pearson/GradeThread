import { MapPin } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  FLIPDESK_SOURCE_TYPES,
  FLIPDESK_SOURCE_TYPE_LABELS,
} from "@/lib/constants";

export function FlipdeskSourcesPage() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-navy text-white">
          <MapPin className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Sources</h1>
          <p className="text-sm text-muted-foreground">
            Track where inventory comes from — thrift trips, estate sales,
            auction lots, wholesale.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Source types</CardTitle>
          <CardDescription>
            Every inventory item links to a source record so you can attribute
            ROI by where the item came from.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {FLIPDESK_SOURCE_TYPES.map((type) => (
              <Badge key={type} variant="outline">
                {FLIPDESK_SOURCE_TYPE_LABELS[type]}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Coming soon</CardTitle>
          <CardDescription>
            Source CRUD, per-source ROI dashboards, and best-day-of-week
            patterns to plan your sourcing routes.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
