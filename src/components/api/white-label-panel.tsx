// US-596: white-label / embeddable results for partner platforms. Lets a
// Business-plan partner store their brand (name, color, logo, support URL) and
// generates a copy-paste <iframe> snippet that renders any GradeThread grade
// certificate under that brand at /embed/grade/:id.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Loader2, Palette } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";

interface Branding {
  company_name?: string;
  brand_color?: string;
  logo_url?: string;
  support_url?: string;
}

function buildEmbedSnippet(certId: string, b: Branding): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://gradethread.com";
  const params = new URLSearchParams();
  if (b.company_name) params.set("company", b.company_name);
  if (b.brand_color) params.set("color", b.brand_color);
  if (b.logo_url) params.set("logo", b.logo_url);
  if (b.support_url) params.set("support", b.support_url);
  const qs = params.toString();
  const src = `${origin}/embed/grade/${encodeURIComponent(certId || "CERTIFICATE_ID")}${qs ? `?${qs}` : ""}`;
  return `<iframe src="${src}" width="100%" height="520" style="border:0;max-width:480px" title="Condition grade" loading="lazy"></iframe>`;
}

export function WhiteLabelPanel() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Branding>({});
  const [saving, setSaving] = useState(false);
  const [certId, setCertId] = useState("");
  const [copied, setCopied] = useState(false);

  const { data, isLoading } = useQuery<Branding>({
    queryKey: ["api-branding"],
    queryFn: async () => {
      const res = await edgeFetch("/api/keys/branding");
      if (!res.ok) throw new Error("Failed to load branding");
      const json = await res.json();
      return (json.data as Branding) ?? {};
    },
    staleTime: 5 * 60 * 1000,
  });

  // Seed the form once the stored branding loads.
  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  async function handleSave() {
    setSaving(true);
    try {
      const body: Branding = {
        company_name: form.company_name?.trim() || undefined,
        brand_color: form.brand_color?.trim() || undefined,
        logo_url: form.logo_url?.trim() || undefined,
        support_url: form.support_url?.trim() || undefined,
      };
      const res = await edgeFetch("/api/keys/branding", { method: "PUT", json: body });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to save branding");
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["api-branding"] });
      toast.success("Branding saved");
    } catch {
      toast.error("Failed to save branding");
    } finally {
      setSaving(false);
    }
  }

  async function copySnippet() {
    try {
      await navigator.clipboard.writeText(buildEmbedSnippet(certId, form));
      setCopied(true);
      toast.success("Embed snippet copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Palette className="h-5 w-5" />
          White-label Embed
        </CardTitle>
        <CardDescription>
          Embed any GradeThread grade certificate inside your own platform, under
          your brand. Set your branding, then paste the generated snippet where
          you want the result to appear.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="brand-company">Company name</Label>
                <Input
                  id="brand-company"
                  placeholder="Acme Resale"
                  value={form.company_name ?? ""}
                  maxLength={80}
                  onChange={(e) => setForm((f) => ({ ...f, company_name: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="brand-color">Brand color (hex)</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="brand-color"
                    placeholder="#0F3460"
                    value={form.brand_color ?? ""}
                    onChange={(e) => setForm((f) => ({ ...f, brand_color: e.target.value }))}
                  />
                  <span
                    aria-hidden
                    className="h-9 w-9 flex-shrink-0 rounded-md border"
                    style={{ backgroundColor: /^#[0-9a-fA-F]{6}$/.test(form.brand_color ?? "") ? form.brand_color : "transparent" }}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="brand-logo">Logo URL (https)</Label>
                <Input
                  id="brand-logo"
                  placeholder="https://acme.com/logo.png"
                  value={form.logo_url ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, logo_url: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="brand-support">Support URL (https)</Label>
                <Input
                  id="brand-support"
                  placeholder="https://acme.com/support"
                  value={form.support_url ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, support_url: e.target.value }))}
                />
              </div>
            </div>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save branding
            </Button>

            <div className="space-y-3 border-t pt-6">
              <div className="space-y-2">
                <Label htmlFor="embed-cert">Certificate ID to embed (preview)</Label>
                <Input
                  id="embed-cert"
                  placeholder="e.g. a certificate_id from a completed grade"
                  value={certId}
                  onChange={(e) => setCertId(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="embed-snippet">Embed snippet</Label>
                <div className="flex items-start gap-2">
                  <textarea
                    id="embed-snippet"
                    readOnly
                    rows={3}
                    className="flex-1 rounded-md border bg-muted p-3 font-mono text-xs break-all"
                    value={buildEmbedSnippet(certId, form)}
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={copySnippet}
                    aria-label={copied ? "Snippet copied" : "Copy embed snippet"}
                  >
                    {copied ? <Check className="h-4 w-4 text-green-600" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Buyers see the grade in your brand; a small &quot;Verified by
                  GradeThread&quot; line keeps the result independently trustworthy.
                </p>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
