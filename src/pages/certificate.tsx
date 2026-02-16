import { useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Shield } from "lucide-react";

export function CertificatePage() {
  const { id } = useParams<{ id: string }>();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-lg">
        <CardHeader className="text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-navy text-white">
            <Shield className="h-6 w-6" />
          </div>
          <CardTitle className="mt-4">GradeThread Certificate</CardTitle>
        </CardHeader>
        <CardContent className="text-center">
          <p className="text-sm text-muted-foreground">
            Certificate ID: <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{id}</code>
          </p>
          <p className="mt-4 text-sm text-muted-foreground">
            Certificate verification and display coming soon.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
