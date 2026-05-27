import Foundation
import StoreKit
import UIKit

/// Gates the in-app App Store review prompt per the US-199 AC: only fires
/// after the user has published 3+ listings AND it's been at least 14
/// days since install AND we haven't asked in the last 365 days.
///
/// Three counters live in UserDefaults so they survive launches and
/// account switches. `recordPublish()` bumps the counter; `maybePrompt()`
/// is called from views that want to ask — typically the publish-success
/// path. The service decides whether to actually fire the system prompt.
///
/// Apple's `SKStoreReviewController.requestReview` already throttles
/// itself (max 3 prompts per 365 days globally), so the local gate is
/// belt-and-suspenders: we want to give the *signal* that we'd like to
/// ask, and Apple decides whether to honor it.
@MainActor
public final class ReviewPromptService {

    public static let shared = ReviewPromptService()

    private static let installDateKey = "com.gradethread.app.review.installDate"
    private static let listingsPublishedKey = "com.gradethread.app.review.listingsPublished"
    private static let lastAskedAtKey = "com.gradethread.app.review.lastAskedAt"

    /// 14 days per the AC — long enough that early enthusiasm has worn
    /// off + the user has cataloged enough to have an opinion.
    private static let minDaysSinceInstall: TimeInterval = 14 * 24 * 60 * 60
    /// 365 days per the AC — matches Apple's per-year cap so we don't
    /// burn through our quota too fast.
    private static let minDaysBetweenAsks: TimeInterval = 365 * 24 * 60 * 60
    private static let minListings: Int = 3

    private init() {
        // Stamp the install date on first launch. UserDefaults preserves
        // it across launches; the only way it disappears is a delete +
        // reinstall, which is a fresh-user signal anyway.
        if UserDefaults.standard.object(forKey: Self.installDateKey) == nil {
            UserDefaults.standard.set(Date.now, forKey: Self.installDateKey)
        }
    }

    // MARK: - Counters

    public var listingsPublished: Int {
        UserDefaults.standard.integer(forKey: Self.listingsPublishedKey)
    }

    public var installDate: Date {
        UserDefaults.standard.object(forKey: Self.installDateKey) as? Date ?? .now
    }

    public var lastAskedAt: Date? {
        UserDefaults.standard.object(forKey: Self.lastAskedAtKey) as? Date
    }

    public func recordPublish() {
        let next = listingsPublished + 1
        UserDefaults.standard.set(next, forKey: Self.listingsPublishedKey)
    }

    // MARK: - Decision

    /// Returns true iff all three conditions are met. Exposed for tests
    /// + observability; the production call sites use `maybePrompt()`.
    public func isEligibleToPrompt(now: Date = .now) -> Bool {
        guard listingsPublished >= Self.minListings else { return false }

        let sinceInstall = now.timeIntervalSince(installDate)
        guard sinceInstall >= Self.minDaysSinceInstall else { return false }

        if let last = lastAskedAt {
            let sinceLast = now.timeIntervalSince(last)
            guard sinceLast >= Self.minDaysBetweenAsks else { return false }
        }

        return true
    }

    /// Fires the system review prompt when the gate allows. Apple
    /// internally throttles + may choose not to show it; either way we
    /// stamp `lastAskedAt` so we don't ask again for a year.
    public func maybePrompt() {
        guard isEligibleToPrompt() else { return }
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first(where: { $0.activationState == .foregroundActive })
        guard let scene else { return }
        SKStoreReviewController.requestReview(in: scene)
        UserDefaults.standard.set(Date.now, forKey: Self.lastAskedAtKey)
    }

    /// Test hook — lets unit tests inject the persisted state without
    /// waiting 14 real days.
    public func _setForTesting(
        installDaysAgo: Int? = nil,
        listingsPublished: Int? = nil,
        lastAskedDaysAgo: Int? = nil
    ) {
        if let days = installDaysAgo {
            let date = Calendar.current.date(byAdding: .day, value: -days, to: .now)!
            UserDefaults.standard.set(date, forKey: Self.installDateKey)
        }
        if let count = listingsPublished {
            UserDefaults.standard.set(count, forKey: Self.listingsPublishedKey)
        }
        if let days = lastAskedDaysAgo {
            let date = Calendar.current.date(byAdding: .day, value: -days, to: .now)!
            UserDefaults.standard.set(date, forKey: Self.lastAskedAtKey)
        }
    }

    public func _resetForTesting() {
        UserDefaults.standard.removeObject(forKey: Self.installDateKey)
        UserDefaults.standard.removeObject(forKey: Self.listingsPublishedKey)
        UserDefaults.standard.removeObject(forKey: Self.lastAskedAtKey)
        // Re-stamp install date so init's idempotence holds.
        UserDefaults.standard.set(Date.now, forKey: Self.installDateKey)
    }
}
