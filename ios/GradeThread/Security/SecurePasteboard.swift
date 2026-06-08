import UIKit
import UniformTypeIdentifiers

/// US-697 — copying a capability value (a workspace invite-accept URL, a
/// referral code) to the *general* pasteboard is risky: it has no expiry and,
/// via Universal Clipboard, syncs to the user's other devices where any
/// foregrounded app can read it. This helper copies such values local-only and
/// with a short expiry so the token doesn't linger or leave the device.
enum SecurePasteboard {

    /// Copies a sensitive string that should expire and stay on this device.
    static func copy(_ string: String, expiresIn: TimeInterval = 120) {
        UIPasteboard.general.setItems(
            [[UTType.utf8PlainText.identifier: string]],
            options: [
                .localOnly: true,
                .expirationDate: Date().addingTimeInterval(expiresIn),
            ]
        )
    }
}
