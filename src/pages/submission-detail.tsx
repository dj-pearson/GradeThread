import { useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function SubmissionDetailPage() {
  const { id } = useParams<{ id: string }>();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Submission Detail</h1>
        <p className="text-muted-foreground">Submission ID: {id}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Grade Report</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            Submission details and grade report will be displayed here.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
