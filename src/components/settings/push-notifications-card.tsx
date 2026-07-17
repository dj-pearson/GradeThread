import { useEffect, useState } from "react";
import { Bell, BellOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  getPushPermission,
  isPushSupported,
  isSubscribed,
  subscribeToPush,
  unsubscribeFromPush,
} from "@/lib/web-push-client";

// US-1901: browser push opt-in. Permission is requested ONLY on an explicit
// toggle click — never on mount (mount only READS the current state). Email
// remains the fallback channel in every unsupported/denied branch.
export function PushNotificationsCard() {
  const [supported] = useState<boolean>(() => isPushSupported());
  const [permission, setPermission] = useState<
    NotificationPermission | "unsupported"
  >(() => getPushPermission());
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);

  // Read-only state sync on mount — does NOT trigger a permission prompt.
  useEffect(() => {
    if (!supported) return;
    let active = true;
    void isSubscribed().then((s) => {
      if (active) setSubscribed(s);
    });
    return () => {
      active = false;
    };
  }, [supported]);

  async function handleEnable() {
    setBusy(true);
    try {
      const result = await subscribeToPush();
      setPermission(getPushPermission());
      if (result.ok) {
        setSubscribed(true);
        toast.success("Push notifications enabled");
        return;
      }
      switch (result.reason) {
        case "denied":
          toast.error("Push permission was blocked", {
            description:
              "Enable notifications for this site in your browser settings, then try again. Email notifications stay on.",
          });
          break;
        case "unprovisioned":
          toast.error("Push isn't available right now", {
            description: "You'll keep getting email and in-app notifications.",
          });
          break;
        default:
          toast.error("Couldn't enable push notifications", {
            description: "Please try again. Email notifications stay on.",
          });
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable() {
    setBusy(true);
    try {
      const ok = await unsubscribeFromPush();
      if (ok) {
        setSubscribed(false);
        toast.success("Push notifications disabled");
      } else {
        toast.error("Couldn't disable push notifications");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="h-5 w-5 text-primary" />
          Push notifications
        </CardTitle>
        <CardDescription>
          Get real-time alerts on this device for offers, messages, and sales —
          even when GradeThread isn't open. You choose which categories send push
          above; email remains your fallback.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!supported && (
          <p className="text-sm text-muted-foreground">
            Your browser doesn't support push notifications. Email notifications
            remain on.
          </p>
        )}

        {supported && permission === "denied" && !subscribed && (
          <p className="text-sm text-muted-foreground">
            Push is blocked for this site in your browser settings. Re-enable it
            there to turn on push. Email notifications stay on in the meantime.
          </p>
        )}

        {supported && subscribed && (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-center gap-2 text-sm font-medium text-green-600">
              <Bell className="h-4 w-4" /> Push enabled on this device
            </p>
            <Button
              variant="outline"
              onClick={handleDisable}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <BellOff className="mr-2 h-4 w-4" />
              )}
              Disable push
            </Button>
          </div>
        )}

        {supported && !subscribed && permission !== "denied" && (
          <Button onClick={handleEnable} disabled={busy}>
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Bell className="mr-2 h-4 w-4" />
            )}
            Enable push
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
