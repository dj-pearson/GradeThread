import Foundation
import PostHog

/// Thin wrapper over PostHog feature flags so A/B tests + experimental
/// rollouts don't have to import the PostHog symbol everywhere. Call
/// sites read flags through this:
///
///     if FeatureFlag.isEnabled(.photoFirstByDefault) { ... }
///
/// UserDefaults overrides let internal builds + UI tests pin a flag to
/// a known state regardless of what PostHog returns. The override key
/// is `com.gradethread.app.flagOverride.<rawValue>` per flag; setting
/// it to nil clears.
@MainActor
public enum FeatureFlag: String, CaseIterable {
    /// Whether the Add tab's default action should be Photo-first
    /// instead of Details-first. Pilot experiment to test which intake
    /// pattern lands more items per session.
    case photoFirstByDefault = "photo_first_by_default"

    /// Surfaces the "Bulk price drop" multi-step picker (-5/-10/-15%)
    /// instead of the single -10% chip. Defaults off; flips on for the
    /// experimental cohort.
    case bulkPriceDropMultiStep = "bulk_price_drop_multistep"

    /// Whether to show the AI-confidence bars in the AIExtractView
    /// review screen. Some testers said the numbers added cognitive
    /// load — A/B test confirms.
    case showConfidenceBars = "show_confidence_bars"

    // MARK: - Reads

    /// True iff the flag is on for this user. Resolution order:
    ///   1. UserDefaults override (set via `_setOverride` from tests
    ///      or a hidden debug menu)
    ///   2. PostHog server-evaluated value
    ///   3. Default (each case picks one — see ``defaultValue``).
    public static func isEnabled(_ flag: FeatureFlag) -> Bool {
        if let override = readOverride(flag) { return override }

        // `getFeatureFlag` returns nil ONLY when the flag is absent server-side
        // (or analytics opt-in is off / flags haven't loaded). When it's present
        // we honor the server's evaluated boolean — otherwise a kill-switch set
        // OFF could never disable a default-ON flag (`isEnabled` alone can't tell
        // "configured off" from "not configured"). Fall back to the per-flag
        // default only when the flag is genuinely unconfigured.
        guard PostHogSDK.shared.getFeatureFlag(flag.rawValue) != nil else {
            return flag.defaultValue
        }
        return PostHogSDK.shared.isFeatureEnabled(flag.rawValue)
    }

    /// Default when both override and server return nothing.
    public var defaultValue: Bool {
        switch self {
        case .photoFirstByDefault:    return false
        case .bulkPriceDropMultiStep: return false
        case .showConfidenceBars:     return true
        }
    }

    // MARK: - Test / debug overrides

    private static let overrideKeyPrefix = "com.gradethread.app.flagOverride."

    public static func _setOverride(_ flag: FeatureFlag, value: Bool?) {
        let key = overrideKeyPrefix + flag.rawValue
        if let value {
            UserDefaults.standard.set(value, forKey: key)
        } else {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }

    private static func readOverride(_ flag: FeatureFlag) -> Bool? {
        let key = overrideKeyPrefix + flag.rawValue
        guard UserDefaults.standard.object(forKey: key) != nil else { return nil }
        return UserDefaults.standard.bool(forKey: key)
    }
}
