import { useCallback, useEffect, useState } from "react";
import {
  ShieldCheck,
  ShieldAlert,
  Loader2,
  KeyRound,
  Copy,
  Download,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { supabase } from "@/lib/supabase";
import { challengeAndVerifyTotp } from "@/lib/mfa";
import { edgeFetch } from "@/lib/edge-fetch";
import { downloadBlob } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// US-374: self-serve TOTP enrollment + recovery codes for ALL users (previously
// admin-only via AdminMfaGate). Enrollment goes client→Supabase
// (supabase.auth.mfa.*); recovery codes are minted/consumed by the edge service
// (/api/account/mfa/*), which stores only SHA-256 hashes.

type VerifiedFactor = { id: string };

export function MfaCard() {
  const [loading, setLoading] = useState(true);
  const [factor, setFactor] = useState<VerifiedFactor | null>(null);
  const [aal2, setAal2] = useState(false);
  const [recoveryRemaining, setRecoveryRemaining] = useState<number | null>(null);

  // Enrollment sub-state
  const [enrolling, setEnrolling] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [enrollFactorId, setEnrollFactorId] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const [{ data: factors }, { data: aal }] = await Promise.all([
        supabase.auth.mfa.listFactors(),
        supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
      ]);
      const verified = factors?.totp?.find((f) => f.status === "verified");
      setFactor(verified ? { id: verified.id } : null);
      setAal2(aal?.currentLevel === "aal2");
      if (verified) {
        const res = await edgeFetch("/api/account/mfa/recovery-codes", {
          method: "GET",
          skipWorkspaceHeader: true,
        });
        const json = (await res.json().catch(() => ({}))) as { remaining?: number };
        setRecoveryRemaining(res.ok ? json.remaining ?? 0 : null);
      } else {
        setRecoveryRemaining(null);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function startEnroll() {
    setErr(null);
    setBusy(true);
    try {
      // Clean up any abandoned, unverified factor first so enroll doesn't
      // collide on a stale friendly name. listFactors().totp is verified-only,
      // so use .all to reach unverified factors.
      const { data: existing } = await supabase.auth.mfa.listFactors();
      for (const f of existing?.all ?? []) {
        if (f.factor_type === "totp" && f.status === "unverified") {
          await supabase.auth.mfa.unenroll({ factorId: f.id }).catch(() => {});
        }
      }
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" });
      if (error) throw error;
      setEnrollFactorId(data.id);
      setQr(data.totp.qr_code);
      setSecret(data.totp.secret);
      setEnrolling(true);
      setCode("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function cancelEnroll() {
    if (enrollFactorId) {
      supabase.auth.mfa.unenroll({ factorId: enrollFactorId }).catch(() => {});
    }
    setEnrolling(false);
    setEnrollFactorId(null);
    setQr(null);
    setSecret(null);
    setCode("");
    setErr(null);
  }

  async function verifyEnroll() {
    if (!enrollFactorId) return;
    setBusy(true);
    setErr(null);
    try {
      await challengeAndVerifyTotp(enrollFactorId, code);
      // Session is now AAL2 — immediately mint a first set of recovery codes.
      setEnrolling(false);
      setEnrollFactorId(null);
      setQr(null);
      setSecret(null);
      setCode("");
      toast.success("Two-factor authentication enabled.");
      await generateRecoveryCodes();
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Challenge an already-verified factor to elevate the session to AAL2 — needed
  // before regenerating recovery codes or removing the factor.
  async function elevate(): Promise<boolean> {
    if (!factor) return false;
    setBusy(true);
    setErr(null);
    try {
      await challengeAndVerifyTotp(factor.id, code);
      setCode("");
      setAal2(true);
      return true;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function generateRecoveryCodes() {
    const res = await edgeFetch("/api/account/mfa/recovery-codes", {
      method: "POST",
      skipWorkspaceHeader: true,
    });
    const json = (await res.json().catch(() => ({}))) as {
      codes?: string[];
      error?: string;
    };
    if (!res.ok) {
      toast.error(json.error ?? "Couldn't generate recovery codes.");
      return;
    }
    setNewCodes(json.codes ?? []);
    setRecoveryRemaining(json.codes?.length ?? 0);
  }

  async function removeFactor() {
    if (!factor) return;
    setBusy(true);
    setErr(null);
    try {
      const { error } = await supabase.auth.mfa.unenroll({ factorId: factor.id });
      if (error) throw error;
      toast.success("Two-factor authentication disabled.");
      setNewCodes(null);
      await refresh();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
      setRemoveOpen(false);
    }
  }

  function copyCodes() {
    if (!newCodes) return;
    navigator.clipboard
      .writeText(newCodes.join("\n"))
      .then(() => toast.success("Recovery codes copied"))
      .catch(() => toast.error("Couldn't copy — select and copy them manually."));
  }

  function downloadCodes() {
    if (!newCodes) return;
    const body =
      "GradeThread two-factor recovery codes\n" +
      "Each code works once. Store them somewhere safe.\n\n" +
      newCodes.join("\n") +
      "\n";
    downloadBlob(new Blob([body], { type: "text/plain" }), "gradethread-recovery-codes.txt");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          Two-Factor Authentication
        </CardTitle>
        <CardDescription>
          Add a one-time code from an authenticator app (Google Authenticator,
          1Password, Authy, …) as a second factor when signing in. Strongly
          recommended for accounts that manage inventory, sales, or a team.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading ? (
          <div className="flex h-20 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : factor ? (
          // ── Enrolled ────────────────────────────────────────────────
          <>
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Badge variant="default">Enabled</Badge>
                <span className="text-sm text-muted-foreground">
                  Authenticator app
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRemoveOpen(true)}
                disabled={busy}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Disable
              </Button>
            </div>

            <Separator />

            {/* Recovery codes */}
            <div className="space-y-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">Recovery codes</p>
                <p className="text-xs text-muted-foreground">
                  Single-use backup codes for signing in if you lose your
                  authenticator device.{" "}
                  {recoveryRemaining !== null && (
                    <span
                      className={
                        recoveryRemaining === 0 ? "text-destructive font-medium" : ""
                      }
                    >
                      {recoveryRemaining} unused code
                      {recoveryRemaining === 1 ? "" : "s"} remaining.
                    </span>
                  )}
                </p>
              </div>

              {newCodes ? (
                <div className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-4">
                  <p className="text-xs font-medium text-foreground">
                    Save these now — they won't be shown again. Each works once.
                  </p>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-sm">
                    {newCodes.map((cd) => (
                      <span key={cd}>{cd}</span>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={copyCodes}>
                      <Copy className="mr-2 h-4 w-4" /> Copy
                    </Button>
                    <Button variant="outline" size="sm" onClick={downloadCodes}>
                      <Download className="mr-2 h-4 w-4" /> Download
                    </Button>
                    <Button size="sm" onClick={() => setNewCodes(null)}>
                      I've saved them
                    </Button>
                  </div>
                </div>
              ) : aal2 ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={generateRecoveryCodes}
                  disabled={busy}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  {recoveryRemaining && recoveryRemaining > 0
                    ? "Regenerate recovery codes"
                    : "Generate recovery codes"}
                </Button>
              ) : (
                // Need a fresh challenge to reach AAL2 before minting codes.
                <div className="space-y-2">
                  <Label htmlFor="mfa-elevate-code" className="text-xs">
                    Enter a current 6-digit code to manage recovery codes
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="mfa-elevate-code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      placeholder="123456"
                      className="max-w-[160px]"
                    />
                    <Button
                      size="sm"
                      onClick={async () => {
                        if (await elevate()) await generateRecoveryCodes();
                      }}
                      disabled={busy || code.trim().length < 6}
                    >
                      {busy ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        "Verify"
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </div>
            {err && <p className="text-sm text-destructive">{err}</p>}
          </>
        ) : enrolling ? (
          // ── Enrollment in progress ──────────────────────────────────
          <div className="space-y-4">
            {qr && (
              <div className="flex justify-center">
                <img src={qr} alt="Authenticator QR code" className="h-44 w-44" />
              </div>
            )}
            {secret && (
              <p className="text-center text-xs text-muted-foreground">
                Or enter this secret manually:{" "}
                <code className="rounded bg-muted px-1.5 py-0.5">{secret}</code>
              </p>
            )}
            <div className="space-y-2">
              <Label htmlFor="mfa-enroll-code">6-digit code</Label>
              <Input
                id="mfa-enroll-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
              />
            </div>
            {err && <p className="text-sm text-destructive">{err}</p>}
            <div className="flex gap-2">
              <Button
                onClick={verifyEnroll}
                disabled={busy || code.trim().length < 6}
              >
                {busy ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <KeyRound className="mr-2 h-4 w-4" />
                )}
                Verify &amp; enable
              </Button>
              <Button variant="ghost" onClick={cancelEnroll} disabled={busy}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          // ── Not enrolled ────────────────────────────────────────────
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                Two-factor authentication is off.
              </span>
            </div>
            {err && <p className="text-sm text-destructive">{err}</p>}
            <Button onClick={startEnroll} disabled={busy}>
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="mr-2 h-4 w-4" />
              )}
              Set up two-factor authentication
            </Button>
          </div>
        )}
      </CardContent>

      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disable two-factor authentication?</AlertDialogTitle>
            <AlertDialogDescription>
              Your account will be protected by your password only. If a
              workspace you belong to requires 2FA, you may lose access until you
              re-enable it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={removeFactor}>Disable</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
