import Foundation

/// US-3238 — the `UserDefaults` keys that belong to the signed-in seller, and
/// the ones that belong to the device.
///
/// Sign-out already clears a great deal (US-659 / US-1499 / US-1646 / US-1647 /
/// US-3224): the SwiftData cache, the mutation queue, drafts, recent searches,
/// saved filters, exports, the thumbnail caches, the edge response cache, the
/// push token, the sync watermarks. `UserDefaults` was the gap. What the next
/// account signing in on the same device used to inherit:
///
///  - **the previous seller's currency and sourcing budget**, so every money
///    screen was denominated in someone else's currency;
///  - **their onboarding answers**, so the app configured itself for a business
///    the new user does not run, and the activation checklist arrived already
///    dismissed;
///  - **a pending plan selection tied to another email address**;
///  - **a snoozed reconcile badge**, silently muting the new user's own
///    unreconciled orders. `ReconcileBadgeStore.reset()` was written for exactly
///    this in US-1262, with a comment saying "e.g. on sign-out" — and nothing
///    ever called it;
///  - **a pending deep-link route** into the previous account's item;
///  - **a radar-contribution consent** given by a different person.
///
/// Both lists are checked against the app's key constants by
/// `ios/Scripts/check-signout-defaults.py`, so a new account-scoped key cannot
/// be added without a decision about which list it belongs in.
enum AccountScopedDefaults {

    /// Cleared on sign-out. Each entry names the key constant it mirrors so the
    /// guard script can match them up.
    static let accountScopedKeys: [String] = [
        // Settings → business preferences. The next seller's money is not in
        // this currency and their budget is not this number.
        "com.gradethread.app.pref.measurementUnit",
        "com.gradethread.app.pref.currencyCode",
        "com.gradethread.app.pref.sourcingBudget",
        "com.gradethread.app.pref.usageAlertThreshold",
        // Consent belongs to a person, not a handset.
        "com.gradethread.app.pref.radarContribute",
        // Onboarding + activation: answers about one seller's business.
        "com.gradethread.app.onboarding.completed.v1",
        "com.gradethread.app.onboarding.useCase.v1",
        "com.gradethread.app.onboarding.pendingFirstAction.v1",
        "com.gradethread.app.onboarding.replaying",
        "com.gradethread.app.onboarding.useCaseSynced.v1",
        "com.gradethread.app.activationChecklistDismissed",
        // A checkout half-started by someone else, carrying their email.
        "com.gradethread.app.planSelection.pending.v1",
        "com.gradethread.app.planSelection.pending.email.v1",
        "com.gradethread.app.planSelection.eligible.v1",
        "com.gradethread.app.planSelection.offered.v1",
        // A dismissal that would mute the next user's own unreconciled orders.
        "com.gradethread.app.reconcile.snoozeUntil.v1",
        "com.gradethread.app.reconcile.snoozeBaseline.v1",
        // A route into the previous account's item, replayed on next launch.
        "com.gradethread.app.pendingDeepLinkRoute",
        // How many listings THIS seller published, feeding the review prompt.
        "com.gradethread.app.review.listingsPublished",
    ]

    /// Deliberately kept across sign-out, each with the reason. These describe
    /// the handset or its owner's choices about the app, not the account.
    static let deviceScopedKeys: [String: String] = [
        "com.gradethread.app.applock.enabled": "the lock protects the device, and re-arming it is the point",
        "com.gradethread.app.applock.biometricsOnly": "same as applock.enabled",
        "com.gradethread.app.analytics.enabled": "an opt-out must survive; re-enabling it silently would be the bug",
        "com.gradethread.app.realtime.enabled": "a data-usage choice about this handset",
        "com.gradethread.app.bgRefresh.enabled": "a battery choice about this handset",
        "com.gradethread.app.push.proactivelyRequested.v1": "whether THIS device has already shown the system prompt",
        "com.gradethread.app.review.installDate": "when the app landed on this device",
        "com.gradethread.app.review.lastAskedAt": "App Store review prompts are rate-limited per device by the OS anyway",
    ]

    /// Keys another teardown path already owns. Listed so the guard can tell
    /// "handled elsewhere" from "forgotten", which is the distinction that let
    /// the preference keys sit unhandled behind a very thorough sign-out block.
    static let clearedElsewhereKeys: [String: String] = [
        "com.gradethread.app.activeWorkspaceOwnerId": "WorkspaceScope.clear()",
        "com.gradethread.app.syncWatermark.schemaVersion": "SyncWatermark.resetAll()",
        "com.gradethread.app.bgRefresh.lastSaleSeenId": "BackgroundRefreshService.resetDetectionBaselines()",
        "com.gradethread.app.bgRefresh.lastGradedIds": "BackgroundRefreshService.resetDetectionBaselines()",
        "com.gradethread.app.push.tokenHex": "PushService.clearTokenOnSignOut()",
        "com.gradethread.app.push.registeredTokenHex": "PushService.clearTokenOnSignOut()",
        "com.gradethread.app.intakeDraft": "IntakeDraftStore.clear()",
        "com.gradethread.auth.appleUserId": "AppleCredentialMonitor.clear()",
        "com.gradethread.inventory.recentSearches": "RecentSearchStore().clear()",
        "com.gradethread.inventory.savedFilters": "SavedFilterStore().clear()",
    ]

    /// Drops every account-scoped key. Called from the sign-out teardown in
    /// `ContentView`, which is the choke point every sign-out path reaches —
    /// explicit sign-out, account deletion, token expiry and Apple-credential
    /// revocation all drive `phase` to `.signedOut`.
    static func clear(_ defaults: UserDefaults = .standard) {
        for key in accountScopedKeys {
            defaults.removeObject(forKey: key)
        }
    }
}
