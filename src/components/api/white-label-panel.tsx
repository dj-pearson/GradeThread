// US-596: white-label / embeddable results for partner platforms. Lets a
// Business-plan partner store their brand (name, color, logo, support URL) and
// generates a copy-paste snippet that renders any GradeThread grade certificate
// under that brand.
//
// US-1936: the snippet is a <script> widget, not an <iframe>. The zone ships
// X-Frame-Options: DENY + CSP frame-ancestors 'none' globally (anti-clickjacking,
// public/_headers), so a same-origin iframe is blocked cross-site — the grade
// widget injects itself straight into the host DOM instead (functions/embed/
// grade/[id].ts), the same pattern the cert trust badge uses.
import { useEffect, useRef, useState } from "react";
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
import { ErrorState } from "@/components/ui/error-state";
import { toast } from "sonner";
import { edgeFetch } from "@/lib/edge-fetch";
import { useTenantKey } from "@/hooks/use-tenant-key";
import { brandHeaderContrast } from "@/lib/brand-contrast";

interface Branding {
  company_name?: string;
  brand_color?: string;
  logo_url?: string;
  support_url?: string;
}

type Field = keyof Branding;
const FIELDS: Field[] = ["company_name", "brand_color", "logo_url", "support_url"];

class BrandingLoadError extends Error {
  constructor(readonly status: number) {
    super("Failed to load branding");
  }
}

function buildEmbedSnippet(certId: string, b: Branding): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://gradethread.com";
  const params = new URLSearchParams();
  if (b.company_name) params.set("company", b.company_name);
  if (b.brand_color) params.set("color", b.brand_color);
  if (b.logo_url) params.set("logo", b.logo_url);
  if (b.support_url) params.set("support", b.support_url);
  const qs = params.toString();
  // US-1936: script widget (injects into the host DOM), not an iframe (blocked by
  // the zone's frame-ancestors 'none'). The `.js` suffix routes to the widget
  // Function; branding rides the query, exactly like the old iframe src.
  const src = `${origin}/embed/grade/${encodeURIComponent(certId || "CERTIFICATE_ID")}.js${qs ? `?${qs}` : ""}`;
  return `<script src="${src}" async></script>`;
}

/**
 * "#fff", "fff" and "0F3460" become "#ffffff" / "#0F3460". Anything else is
 * returned as typed, so validation can point at it.
 */
function normalizeBrandColor(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  const hex = v.startsWith("#") ? v.slice(1) : v;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex.split("").map((c) => c + c).join("")}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return `#${hex}`;
  return v;
}

/** The trimmed, normalized body a save would send. Empty fields are dropped. */
function normalize(form: Branding): Branding {
  const out: Branding = {};
  const name = form.company_name?.trim();
  if (name) out.company_name = name;
  const color = normalizeBrandColor(form.brand_color ?? "");
  if (color) out.brand_color = color;
  for (const f of ["logo_url", "support_url"] as const) {
    const v = form[f]?.trim();
    if (v) out[f] = v;
  }
  return out;
}

/** The same rules as sanitizeBranding in routes/api-keys.ts. */
function validateBranding(b: Branding): Partial<Record<Field, string>> {
  const errors: Partial<Record<Field, string>> = {};
  if (b.company_name && b.company_name.length > 80) {
    errors.company_name = "Use 80 characters or fewer.";
  }
  if (b.brand_color && !/^#[0-9a-fA-F]{6}$/.test(b.brand_color)) {
    errors.brand_color = "Use a hex color like #0F3460.";
  }
  for (const f of ["logo_url", "support_url"] as const) {
    const v = b[f];
    if (!v) continue;
    if (v.length > 500) {
      errors[f] = "Use 500 characters or fewer.";
      continue;
    }
    let url: URL | null = null;
    try {
      url = new URL(v);
    } catch {
      url = null;
    }
    if (!url || url.protocol !== "https:") errors[f] = "Use a full https:// address.";
  }
  return errors;
}

function sameBranding(a: Branding, b: Branding): boolean {
  return FIELDS.every((f) => (a[f] ?? "") === (b[f] ?? ""));
}

export function WhiteLabelPanel() {
  const queryClient = useQueryClient();
  const tenantKey = useTenantKey();
  const [form, setForm] = useState<Branding>({});
  const [saving, setSaving] = useState(false);
  const [certId, setCertId] = useState("");
  const [copied, setCopied] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const seeded = useRef(false);

  const { data, isLoading, isError, error, isFetching, refetch } = useQuery<Branding>({
    queryKey: ["api-branding", tenantKey],
    enabled: Boolean(tenantKey),
    queryFn: async () => {
      const res = await edgeFetch("/api/keys/branding");
      if (!res.ok) throw new BrandingLoadError(res.status);
      const json = await res.json();
      return (json.data as Branding) ?? {};
    },
    staleTime: 5 * 60 * 1000,
  });

  // DEV-08: seed the form ONCE. Re-seeding on every refetch overwrote whatever
  // the seller was in the middle of typing.
  useEffect(() => {
    if (data && !seeded.current) {
      seeded.current = true;
      setForm(data);
    }
  }, [data]);

  const saved: Branding = data ?? {};
  const pending = normalize(form);
  const dirty = data !== undefined && !sameBranding(pending, normalize(saved));
  const errors = validateBranding(pending);
  const hasErrors = Object.keys(errors).length > 0;

  async function handleSave() {
    // A save before the stored branding has loaded would send an empty body
    // over values the seller cannot see. The button is disabled; this is the
    // belt to that brace.
    if (data === undefined) return;
    if (hasErrors) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    try {
      // Emptying every field of saved branding is a deliberate clear, and the
      // server refuses an empty body that does not say so.
      const hadBranding = FIELDS.some((f) => saved[f]);
      const body: Record<string, unknown> = { ...pending };
      if (Object.keys(pending).length === 0 && hadBranding) body.clear = true;
      const res = await edgeFetch("/api/keys/branding", { method: "PUT", json: body });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Failed to save branding");
        return;
      }
      const stored = (json.data as Branding) ?? {};
      queryClient.setQueryData(["api-branding", tenantKey], stored);
      setForm(stored);
      setShowErrors(false);
      toast.success("Branding saved");
    } catch {
      toast.error("Failed to save branding");
    } finally {
      setSaving(false);
    }
  }

  // The snippet is built from what is SAVED, never from the form: a partner
  // pasting it should get the branding the server holds, not a half-typed color.
  const snippet = buildEmbedSnippet(certId, saved);

  async function copySnippet() {
    if (dirty) return;
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      toast.success("Embed snippet copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy");
    }
  }

  function fieldError(f: Field): string | undefined {
    return showErrors || (form[f] ?? "") !== (saved[f] ?? "") ? errors[f] : undefined;
  }

  const contrast = errors.brand_color ? null : brandHeaderContrast(pending.brand_color ?? "");

  const forbidden = isError && error instanceof BrandingLoadError && error.status === 403;

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
        {forbidden ? (
          <p className="text-sm text-muted-foreground">Ask your workspace owner to set branding.</p>
        ) : isError ? (
          <ErrorState
            title="Couldn't load your branding"
            description="Your saved branding is unchanged. Editing is off until it loads, so nothing is overwritten."
            onRetry={() => void refetch()}
            retrying={isFetching}
            hideSupport
          />
        ) : isLoading || data === undefined ? (
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
                  aria-invalid={fieldError("company_name") ? true : undefined}
                  aria-describedby={fieldError("company_name") ? "brand-company-error" : undefined}
                  onChange={(e) => setForm((f) => ({ ...f, company_name: e.target.value }))}
                />
                {fieldError("company_name") && (
                  <p id="brand-company-error" className="text-xs text-destructive">{fieldError("company_name")}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="brand-color">Brand color (hex)</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="brand-color"
                    placeholder="#0F3460"
                    value={form.brand_color ?? ""}
                    aria-invalid={fieldError("brand_color") ? true : undefined}
                    aria-describedby={fieldError("brand_color") ? "brand-color-error" : undefined}
                    onChange={(e) => setForm((f) => ({ ...f, brand_color: e.target.value }))}
                  />
                  <span
                    aria-hidden
                    className="h-9 w-9 flex-shrink-0 rounded-md border"
                    style={{ backgroundColor: /^#[0-9a-fA-F]{6}$/.test(pending.brand_color ?? "") ? pending.brand_color : "transparent" }}
                  />
                </div>
                {fieldError("brand_color") && (
                  <p id="brand-color-error" className="text-xs text-destructive">{fieldError("brand_color")}</p>
                )}
                {contrast && (
                  <p className="text-xs text-muted-foreground" data-testid="brand-contrast">
                    {contrast.ratio >= 4.5
                      ? `The card header will use ${contrast.text === "#fff" ? "white" : "dark"} text (contrast ${contrast.ratio.toFixed(1)}:1).`
                      : `Header text on this color reaches only ${contrast.ratio.toFixed(1)}:1 contrast, below the 4.5:1 WCAG AA minimum. Pick a darker or lighter color.`}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="brand-logo">Logo URL (https)</Label>
                <Input
                  id="brand-logo"
                  placeholder="https://acme.com/logo.png"
                  value={form.logo_url ?? ""}
                  aria-invalid={fieldError("logo_url") ? true : undefined}
                  aria-describedby={fieldError("logo_url") ? "brand-logo-error" : undefined}
                  onChange={(e) => setForm((f) => ({ ...f, logo_url: e.target.value }))}
                />
                {fieldError("logo_url") && (
                  <p id="brand-logo-error" className="text-xs text-destructive">{fieldError("logo_url")}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="brand-support">Support URL (https)</Label>
                <Input
                  id="brand-support"
                  placeholder="https://acme.com/support"
                  value={form.support_url ?? ""}
                  aria-invalid={fieldError("support_url") ? true : undefined}
                  aria-describedby={fieldError("support_url") ? "brand-support-error" : undefined}
                  onChange={(e) => setForm((f) => ({ ...f, support_url: e.target.value }))}
                />
                {fieldError("support_url") && (
                  <p id="brand-support-error" className="text-xs text-destructive">{fieldError("support_url")}</p>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={handleSave} disabled={saving || data === undefined}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save branding
              </Button>
              {dirty && (
                <p className="text-sm text-muted-foreground">You have unsaved changes</p>
              )}
            </div>

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
                    value={snippet}
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={copySnippet}
                    disabled={dirty}
                    title={dirty ? "Save your changes first; the snippet uses saved branding" : undefined}
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
