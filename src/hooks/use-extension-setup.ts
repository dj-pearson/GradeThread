import { useQuery } from "@tanstack/react-query";
import {
  isExtensionInstalled,
  listerUnavailableReason,
  sendExtensionMessage,
} from "@/lib/lister-extension";

// US-2719: the four facts a seller needs to get cross-posting working, read from
// the extension itself rather than guessed at by the web app.
//
// Before this, the Marketplaces page had a paragraph saying "Install the
// GradeThread Lister browser extension" and no link, no status and no next step.
// A seller who had installed it could not tell whether it was signed in; a seller
// who had not could not tell that was the problem. Meanwhile the composer's
// cross-post button was gated behind a build flag and simply did not render, so
// the page's own instruction pointed at a control that was not there (US-2718).
//
// Every field here comes from the extension's GT_PING answer or from the DOM
// marker its bridge content script drops. Nothing is inferred from the account,
// because the extension is the thing enforcing all of it.

export interface ExtensionChannel {
  platform: string;
  label: string;
  /** The channel's selectors are verified, so a send will actually fill a form. */
  canList: boolean;
  /** It can also END a listing. Grailed never can; Vinted cannot yet. */
  canDelist: boolean;
}

export interface ExtensionSetupState {
  /** The extension is present in THIS browser (bridge marker, both browsers). */
  installed: boolean;
  /** It answered a ping. False with installed:true means an old or broken build. */
  reachable: boolean;
  /** A signed extension token is stored, so it knows which account this is. */
  signedIn: boolean;
  /** The account is on an active paid FlipDesk plan. */
  sellerEnabled: boolean;
  /** The Lister clickwrap has been accepted, in the extension, from its own copy. */
  tosAccepted: boolean;
  /** Channels this build will actually run. */
  channels: ExtensionChannel[];
  /** The installed version, when the build is new enough to report it. */
  version: string | null;
  /**
   * Why the cross-post control is unavailable, when it is. `null` means it is
   * available. "disabled" is a deployment fact, not something the seller can fix,
   * so the UI must not ask them to install anything in that case.
   */
  unavailable: ReturnType<typeof listerUnavailableReason>;
}

interface PingResponse {
  ok?: boolean;
  installed?: boolean;
  version?: string;
  tosAccepted?: boolean;
  channels?: ExtensionChannel[];
  capabilities?: {
    authenticated?: boolean;
    sellerEnabled?: boolean;
    lister?: boolean;
  };
}

/** The answer when nothing is installed — every step open, nothing claimed. */
function emptyState(): ExtensionSetupState {
  return {
    installed: false,
    reachable: false,
    signedIn: false,
    sellerEnabled: false,
    tosAccepted: false,
    channels: [],
    version: null,
    unavailable: listerUnavailableReason(),
  };
}

export function useExtensionSetup(enabled = true) {
  return useQuery({
    queryKey: ["extension_setup"],
    enabled,
    // The seller is very likely mid-install while looking at this, so a long
    // cache would show them "not installed" for minutes after they fixed it.
    staleTime: 5 * 1000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<ExtensionSetupState> => {
      const installed = isExtensionInstalled();
      const base = { ...emptyState(), installed };
      if (!installed) return base;

      const res = await sendExtensionMessage<PingResponse>({ type: "GT_PING" });
      if (!res || res.ok === false) return base;

      const caps = res.capabilities ?? {};
      return {
        ...base,
        reachable: true,
        signedIn: caps.authenticated === true,
        sellerEnabled: caps.sellerEnabled === true,
        // An older build does not report this. Treating "did not say" as
        // "accepted" would show a green step for a gate that will refuse the
        // first send, so the honest default is not-yet.
        tosAccepted: res.tosAccepted === true,
        channels: Array.isArray(res.channels) ? res.channels : [],
        version: typeof res.version === "string" ? res.version : null,
      };
    },
  });
}
