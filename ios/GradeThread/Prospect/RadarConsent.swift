import Foundation
import Observation

/// File-level so the nonisolated seed helper on ``RadarConsent`` can read it
/// without hopping to the main actor.
private let radarContributeDefaultsKey = "com.gradethread.app.pref.radarContribute"

/// US-1861 — the Thrift Radar contribution consent on iOS.
///
/// A NEW switch with its OWN storage key and its OWN column
/// (`users.radar_contribute`), deliberately not a widening of the analytics
/// toggle or the sale-outcome one. Both of those have copy that names what they
/// send; location is a different kind of data, so folding it in would make a
/// sentence somebody already read retroactively false.
///
/// Two layers, and both matter:
///   • The SERVER is the authority. The edge reads `users.radar_contribute` on
///     every scan, so a revocation from any device takes effect on the next one
///     even if this device never syncs.
///   • The LOCAL mirror is what stops the app asking the operating system for a
///     position at all while the answer is no. Consent before collection means
///     not collecting, not collecting-and-discarding.
///
/// Default OFF. A device that has never synced reads false, which is the safe
/// direction: the worst case is a contribution that does not happen.
@MainActor
@Observable
final class RadarConsent {

    static let shared = RadarConsent()

    /// The last known value, readable off the main actor so a SwiftUI view can
    /// seed its state before `body` runs. Same default as everything else here:
    /// a device that was never told otherwise reads false.
    nonisolated static func storedContribution(
        defaults: UserDefaults = .standard
    ) -> Bool {
        defaults.bool(forKey: radarContributeDefaultsKey)
    }

    /// The local mirror. Read this before touching CoreLocation.
    private(set) var isContributing: Bool

    /// Set while a write is in flight so the toggle can disable itself.
    private(set) var isSaving = false

    /// Surfaced to the settings row when a save fails, so the switch can snap
    /// back rather than silently disagreeing with the server.
    private(set) var lastError: String?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.isContributing = Self.storedContribution(defaults: defaults)
    }

    private let defaults: UserDefaults

    /// Pull the authoritative value. RLS scopes the SELECT to the caller, so no
    /// explicit filter is needed (same as ``ProfileStore.refresh``).
    func refresh() async {
        struct Row: Decodable {
            let radar_contribute: Bool
        }
        do {
            let rows: [Row] = try await SupabaseShared.client
                .from("users")
                .select("radar_contribute")
                .limit(1)
                .execute()
                .value
            if let row = rows.first {
                apply(row.radar_contribute)
            }
        } catch {
            // A failed read leaves the mirror alone. It is already the
            // conservative value, and guessing here would be guessing about
            // consent.
            Telemetry.breadcrumb(
                "radar consent refresh failed: \(FriendlyErrorCopy.rawDetail(for: error))",
                category: "radar"
            )
        }
    }

    /// Write the new value. Returns nil on success or a message on failure; the
    /// caller reverts the switch on a failure so the UI never claims a consent
    /// state the server does not hold.
    @discardableResult
    func setContributing(_ next: Bool, userId: String) async -> String? {
        struct Update: Encodable { let radar_contribute: Bool }
        isSaving = true
        lastError = nil
        defer { isSaving = false }
        do {
            try await SupabaseShared.client
                .from("users")
                .update(Update(radar_contribute: next))
                .eq("id", value: userId)
                .execute()
            apply(next)
            return nil
        } catch {
            let message = FriendlyErrorCopy.actionMessage(
                for: error,
                fallback: "Couldn't update Radar contribution. Please try again."
            )
            lastError = message
            return message
        }
    }

    private func apply(_ value: Bool) {
        isContributing = value
        defaults.set(value, forKey: radarContributeDefaultsKey)
    }
}
