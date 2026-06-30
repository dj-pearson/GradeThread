import Foundation
import Observation

/// Reads + updates the signed-in user's `users` row (profile + plan +
/// grading usage). RLS scopes both the SELECT and the UPDATE to the caller
/// (`auth.uid() = id`), so no explicit user filter is needed on read.
@MainActor
@Observable
final class ProfileStore {
    struct Profile: Decodable, Equatable {
        let id: String
        let email: String
        let fullName: String?
        let plan: String
        let gradesUsedThisMonth: Int
        let gradeResetAt: String?

        /// "free" → "Free", "professional" → "Professional", etc.
        var planLabel: String {
            plan.isEmpty ? "Free" : plan.prefix(1).uppercased() + plan.dropFirst()
        }

        /// Parsed reset date for display, if present.
        var resetDate: Date? {
            guard let gradeResetAt else { return nil }
            return ISO8601DateFormatter().date(from: gradeResetAt)
                ?? ISO8601DateFormatter.withFractionalSeconds.date(from: gradeResetAt)
        }

        private enum CodingKeys: String, CodingKey {
            case id, email, plan
            case fullName = "full_name"
            case gradesUsedThisMonth = "grades_used_this_month"
            case gradeResetAt = "grade_reset_at"
        }
    }

    enum Phase: Equatable {
        case loading
        case ready(Profile)
        case failed(String)
    }

    var phase: Phase = .loading

    var profile: Profile? {
        if case let .ready(profile) = phase { return profile }
        return nil
    }

    /// US-1407: re-entrancy guard so an overlapping `.task` + `.refreshable`
    /// (or a refresh racing `updateName`) can't run two loads at once.
    private var isRefreshing = false

    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        phase = .loading
        do {
            let rows: [Profile] = try await SupabaseShared.client
                .from("users")
                .select("id, email, full_name, plan, grades_used_this_month, grade_reset_at")
                .limit(1)
                .execute()
                .value
            if let profile = rows.first {
                phase = .ready(profile)
            } else {
                phase = .failed("Profile not found.")
            }
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// Updates `full_name` for the current user. Returns an error message on
    /// failure, or nil on success (then refreshes).
    func updateName(_ name: String, userId: String) async -> String? {
        struct Update: Encodable { let full_name: String? }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try await SupabaseShared.client
                .from("users")
                .update(Update(full_name: trimmed.isEmpty ? nil : trimmed))
                .eq("id", value: userId)
                .execute()
            await refresh()
            return nil
        } catch {
            return error.localizedDescription
        }
    }
}

private extension ISO8601DateFormatter {
    static let withFractionalSeconds: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
