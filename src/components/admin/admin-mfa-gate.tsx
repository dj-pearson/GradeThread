import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, Loader2, KeyRound } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { challengeAndVerifyTotp } from "@/lib/mfa";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// US-270: client-side MFA gate for the admin area. Admins/super-admins must
// have a TOTP factor AND have satisfied it this session (AAL2). This is the
// user-facing enroll/challenge UX; the edge `adminAuthMiddleware` independently
// enforces AAL2 server-side, so this gate is convenience + guidance, never the
// security boundary.

type GateState =
  | { phase: "loading" }
  | { phase: "ready" } // AAL2 satisfied
  | { phase: "challenge"; factorId: string } // enrolled, needs to verify this session
  | { phase: "enroll" } // no factor yet
  | { phase: "error"; message: string };

export function AdminMfaGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>({ phase: "loading" });

  const refresh = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const { data: aal, error } = await supabase.auth.mfa
        .getAuthenticatorAssuranceLevel();
      if (error) throw error;
      if (aal.currentLevel === "aal2") {
        setState({ phase: "ready" });
        return;
      }
      // Not AAL2: do we already have a verified factor to challenge?
      const { data: factors } = await supabase.auth.mfa.listFactors();
      const totp = factors?.totp?.find((f) => f.status === "verified");
      if (totp) {
        setState({ phase: "challenge", factorId: totp.id });
      } else {
        setState({ phase: "enroll" });
      }
    } catch (e) {
      setState({ phase: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (state.phase === "loading") {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (state.phase === "ready") return <>{children}</>;

  return (
    <div className="mx-auto max-w-md py-10">
      {state.phase === "enroll"
        ? <EnrollPanel onDone={refresh} />
        : state.phase === "challenge"
        ? <ChallengePanel factorId={state.factorId} onDone={refresh} />
        : (
          <Card>
            <CardHeader>
              <CardTitle>Couldn’t check MFA status</CardTitle>
              <CardDescription>{state.message}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button onClick={refresh}>Retry</Button>
            </CardContent>
          </Card>
        )}
    </div>
  );
}

function EnrollPanel({ onDone }: { onDone: () => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const startEnroll = useCallback(async () => {
    setErr(null);
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" });
    if (error) {
      setErr(error.message);
      return;
    }
    setFactorId(data.id);
    setQr(data.totp.qr_code);
    setSecret(data.totp.secret);
  }, []);

  useEffect(() => {
    void startEnroll();
  }, [startEnroll]);

  async function verify() {
    if (!factorId) return;
    setBusy(true);
    setErr(null);
    try {
      await challengeAndVerifyTotp(factorId, code);
      onDone(); // session is now AAL2
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5" /> Set up two-factor authentication
        </CardTitle>
        <CardDescription>
          Admin accounts require an authenticator app (TOTP). Scan the code, then
          enter the 6-digit code to finish.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {qr && (
          <div className="flex justify-center">
            {/* Supabase returns an SVG data URL for the otpauth QR. */}
            <img src={qr} alt="Authenticator QR code" className="h-44 w-44" />
          </div>
        )}
        {secret && (
          <p className="text-center text-xs text-muted-foreground">
            Or enter this secret manually:{" "}
            <code className="rounded bg-muted px-1.5 py-0.5">{secret}</code>
          </p>
        )}
        <div>
          <Label htmlFor="enroll-code">6-digit code</Label>
          <Input
            id="enroll-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
          />
        </div>
        {err && <p className="text-sm text-destructive">{err}</p>}
        <Button onClick={verify} disabled={busy || code.trim().length < 6} className="w-full">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
          Verify & enable
        </Button>
      </CardContent>
    </Card>
  );
}

function ChallengePanel({ factorId, onDone }: { factorId: string; onDone: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function verify() {
    setBusy(true);
    setErr(null);
    try {
      await challengeAndVerifyTotp(factorId, code);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5" /> Verify your authenticator
        </CardTitle>
        <CardDescription>
          Enter the current 6-digit code from your authenticator app to access
          the admin area.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label htmlFor="challenge-code">6-digit code</Label>
          <Input
            id="challenge-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
          />
        </div>
        {err && <p className="text-sm text-destructive">{err}</p>}
        <Button onClick={verify} disabled={busy || code.trim().length < 6} className="w-full">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
          Verify
        </Button>
      </CardContent>
    </Card>
  );
}

// US-270: step-up dialog for destructive actions. Performs a fresh MFA
// challenge so the next edge call carries a recent `amr` timestamp (the server
// requires a step-up within the last 5 minutes). Resolves onVerified on success.
export function MfaStepUpDialog({
  open,
  onOpenChange,
  onVerified,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onVerified: () => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function verify() {
    setBusy(true);
    setErr(null);
    try {
      const { data: factors } = await supabase.auth.mfa.listFactors();
      const totp = factors?.totp?.find((f) => f.status === "verified");
      if (!totp) throw new Error("No authenticator enrolled.");
      await challengeAndVerifyTotp(totp.id, code);
      setCode("");
      onOpenChange(false);
      onVerified();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" /> Confirm with your authenticator
          </DialogTitle>
          <DialogDescription>
            This is a sensitive action. Enter the current 6-digit code from your
            authenticator app to continue.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="stepup-code">6-digit code</Label>
            <Input
              id="stepup-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
            />
          </div>
          {err && <p className="text-sm text-destructive">{err}</p>}
          <Button
            onClick={verify}
            disabled={busy || code.trim().length < 6}
            className="w-full"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Confirm
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
