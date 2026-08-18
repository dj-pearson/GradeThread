import SwiftUI
import Observation

// US-2503 AC2, screen 3 of 4: the buyer trust score.
//
// Reads GET /api/buyer/reputation, which resolves the level, the perks and the
// distance to the next level server-side. The web resolves those from its own
// mirror of the perk matrix; a Swift mirror would make three copies of one
// policy, and three copies of a policy matrix is not a lockstep, it is a
// countdown. So the phone renders what it is told.

struct BuyerReputation: Decodable, Equatable {
    let score: Int
    let level: Int
    let levelName: String
    let eventCount: Int
    let computedAt: String?
    let perks: Perks
    let next: NextLevel?

    struct Perks: Decodable, Equatable {
        let guaranteeWindowBonusDays: Int
        let priorityClaimHandling: Bool
        let earlyDropAccess: Bool
        let rewardMultiplier: Double
    }

    struct NextLevel: Decodable, Equatable {
        let levelName: String
        let pointsAway: Int
    }

    /// Level 0 with nothing earned. Not an error state: every buyer starts here,
    /// and telling a new buyer "we could not load this" would be wrong about a
    /// fact we know.
    static let new = BuyerReputation(
        score: 0,
        level: 0,
        levelName: "New",
        eventCount: 0,
        computedAt: nil,
        perks: Perks(
            guaranteeWindowBonusDays: 0,
            priorityClaimHandling: false,
            earlyDropAccess: false,
            rewardMultiplier: 1.0),
        next: nil)
}

@MainActor
@Observable
final class BuyerTrustScoreStore {

    enum Phase: Equatable {
        case loading
        case ready(BuyerReputation)
        case failed(String)
        /// The plan does not include the trust score. A distinct state from
        /// `failed`, because "upgrade to see this" and "we could not load this"
        /// ask the buyer for two completely different things.
        case locked
    }

    private(set) var phase: Phase = .loading

    private let fetch: () async throws -> BuyerReputation

    init(fetch: (() async throws -> BuyerReputation)? = nil) {
        self.fetch = fetch ?? { try await Self.loadReputation() }
    }

    func load(entitlements: BuyerEntitlementsStore) async {
        guard let capability = BuyerCapability.all.first(where: { $0.id == "trustScore" }) else {
            phase = .failed("Trust score is unavailable.")
            return
        }
        guard entitlements.isIncluded(capability) else {
            phase = .locked
            return
        }
        phase = .loading
        do {
            phase = .ready(try await fetch())
        } catch {
            phase = .failed(
                (error as? LocalizedError)?.errorDescription
                    ?? "We couldn't load your trust level.")
        }
    }

    private static func loadReputation() async throws -> BuyerReputation {
        try await EdgeAPI.shared.getJSON("/api/buyer/reputation")
    }
}

struct BuyerTrustScoreView: View {
    @Environment(BuyerEntitlementsStore.self) private var entitlements
    @State private var store = BuyerTrustScoreStore()

    var body: some View {
        List {
            switch store.phase {
            case .loading:
                HStack { Spacer(); ProgressView(); Spacer() }
                    .listRowBackground(Color.clear)
            case .locked:
                lockedSection
            case .failed(let message):
                failedSection(message)
            case .ready(let reputation):
                levelSection(reputation)
                perksSection(reputation)
            }
        }
        .navigationTitle("Trust score")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.load(entitlements: entitlements) }
        .task { await store.load(entitlements: entitlements) }
    }

    // MARK: - Sections

    private func levelSection(_ reputation: BuyerReputation) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text(reputation.levelName)
                    .font(.title2.weight(.semibold))
                Text("\(reputation.score) points")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if let next = reputation.next {
                    // The distance, not a bare percentage: "48 points to
                    // Established" is actionable in a way "62%" is not.
                    Text("\(next.pointsAway) points to \(next.levelName)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("You're at the top level.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .combine)
        } footer: {
            Text(reputation.eventCount == 0
                 ? "Confirm a grade after a purchase to start earning points."
                 : "Built from \(reputation.eventCount) confirmed purchases and grade checks.")
        }
    }

    @ViewBuilder
    private func perksSection(_ reputation: BuyerReputation) -> some View {
        Section {
            if reputation.perks.guaranteeWindowBonusDays > 0 {
                perkRow(
                    "Longer guarantee window",
                    detail: "+\(reputation.perks.guaranteeWindowBonusDays) days on covered purchases",
                    icon: "shield")
            }
            if reputation.perks.rewardMultiplier > 1.0 {
                perkRow(
                    "Bigger rewards",
                    detail: Self.multiplierText(reputation.perks.rewardMultiplier),
                    icon: "gift")
            }
            if reputation.perks.priorityClaimHandling {
                perkRow(
                    "Priority claims",
                    detail: "Your claims are handled ahead of the standard queue",
                    icon: "bolt")
            }
            if reputation.perks.earlyDropAccess {
                perkRow(
                    "Early access",
                    detail: "See graded drops before they go public",
                    icon: "sparkles")
            }
            if !Self.hasAnyPerk(reputation.perks) {
                Text("Reach \(reputation.next?.levelName ?? "the next level") to unlock your first perk.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("What your level gets you")
        }
    }

    private func perkRow(_ title: String, detail: String, icon: String) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline)
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
        } icon: {
            Image(systemName: icon).foregroundStyle(Color.brandNavy)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title). \(detail)")
    }

    private var lockedSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text("Your plan doesn't include the trust score yet.")
                    .font(.subheadline)
                Text("Trust score comes with Guard and above. It grows as you confirm grades after a purchase, and it unlocks a longer guarantee window and bigger rewards.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
        }
    }

    private func failedSection(_ message: String) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                // Says what is unaffected. A trust score that will not load is a
                // display problem, and a buyer should not have to wonder whether
                // their standing was reset.
                Text("We couldn't load your trust level. Your points are safe.")
                    .font(.subheadline)
                Text(message).font(.caption).foregroundStyle(.secondary)
                Button("Try again") {
                    Task { await store.load(entitlements: entitlements) }
                }
                .font(.subheadline)
            }
            .padding(.vertical, 4)
        }
    }

    // MARK: - Copy helpers

    static func hasAnyPerk(_ perks: BuyerReputation.Perks) -> Bool {
        perks.guaranteeWindowBonusDays > 0
            || perks.priorityClaimHandling
            || perks.earlyDropAccess
            || perks.rewardMultiplier > 1.0
    }

    /// 1.25 reads as "25% more", not "1.25x". The multiplier is an
    /// implementation detail; the extra is what the buyer gets.
    static func multiplierText(_ multiplier: Double) -> String {
        let percent = Int(((multiplier - 1.0) * 100).rounded())
        return "\(percent)% more on every reward"
    }
}
