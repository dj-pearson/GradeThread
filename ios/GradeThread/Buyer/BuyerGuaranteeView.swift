import SwiftUI
import Observation

// US-2503 AC2, screen 4 of 4: purchase-guarantee coverage.
//
// The whole guarantee backend has existed for a while — claim intake, admin
// review, the payout pool. What a phone-only subscriber could see of it was
// nothing at all. This is the buyer's answer to "am I covered, for how long,
// and up to how much".
//
// Reads GET /api/buyer/guarantee-coverage, which joins purchases to their
// coverage snapshot and any filed claim. The web builds the same view from five
// parallel reads joined in the browser; reproducing that join here would be a
// second implementation of what a buyer is covered for.

struct BuyerCoveredPurchase: Decodable, Equatable, Identifiable {
    let id: String
    let brand: String?
    let title: String?
    let certificateId: String
    let purchasePriceCents: Int?
    let purchasedAt: String?
    /// nil means no coverage snapshot was taken. DISTINCT from `eligible ==
    /// false`, which means one was taken and it said no. Rendering the two the
    /// same way answers "am I covered?" with a confident no when the truth is
    /// "we have not worked it out".
    let coverage: Coverage?
    let claim: Claim?

    struct Coverage: Decodable, Equatable {
        let eligible: Bool
        let ineligibleReason: String?
        let windowDays: Int
        let payoutCapCents: Int
        let gradeDeltaThreshold: Double
        let coveredUntil: String?

        enum CodingKeys: String, CodingKey {
            case eligible
            case ineligibleReason = "ineligible_reason"
            case windowDays = "window_days"
            case payoutCapCents = "payout_cap_cents"
            case gradeDeltaThreshold = "grade_delta_threshold"
            case coveredUntil = "covered_until"
        }
    }

    struct Claim: Decodable, Equatable {
        let status: String
        let remedyCents: Int
        let remedyCredits: Int

        enum CodingKeys: String, CodingKey {
            case status
            case remedyCents = "remedy_cents"
            case remedyCredits = "remedy_credits"
        }
    }

    var displayName: String {
        let brand = self.brand?.trimmingCharacters(in: .whitespaces) ?? ""
        let title = self.title?.trimmingCharacters(in: .whitespaces) ?? ""
        if !brand.isEmpty && !title.isEmpty { return "\(brand) - \(title)" }
        if !brand.isEmpty { return brand }
        if !title.isEmpty { return title }
        return "Untitled item"
    }
}

private struct CoverageResponse: Decodable {
    let purchases: [BuyerCoveredPurchase]
}

@MainActor
@Observable
final class BuyerGuaranteeStore {

    enum Phase: Equatable {
        case loading
        case ready([BuyerCoveredPurchase])
        case failed(String)
        case locked
    }

    private(set) var phase: Phase = .loading

    private let fetch: () async throws -> [BuyerCoveredPurchase]

    init(fetch: (() async throws -> [BuyerCoveredPurchase])? = nil) {
        self.fetch = fetch ?? { try await Self.loadCoverage() }
    }

    func load(entitlements: BuyerEntitlementsStore) async {
        guard let capability = BuyerCapability.all.first(where: { $0.id == "purchaseGuarantee" }) else {
            phase = .failed("Purchase guarantee is unavailable.")
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
                    ?? "We couldn't load your coverage.")
        }
    }

    private static func loadCoverage() async throws -> [BuyerCoveredPurchase] {
        let response: CoverageResponse =
            try await EdgeAPI.shared.getJSON("/api/buyer/guarantee-coverage")
        return response.purchases
    }
}

struct BuyerGuaranteeView: View {
    @Environment(BuyerEntitlementsStore.self) private var entitlements
    @State private var store = BuyerGuaranteeStore()

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
            case .ready(let purchases):
                if purchases.isEmpty {
                    emptySection
                } else {
                    ForEach(purchases) { purchase in
                        Section { row(purchase) } header: {
                            Text(purchase.displayName)
                        }
                    }
                }
            }
        }
        .navigationTitle("Purchase guarantee")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.load(entitlements: entitlements) }
        .task { await store.load(entitlements: entitlements) }
    }

    // MARK: - Rows

    @ViewBuilder
    private func row(_ purchase: BuyerCoveredPurchase) -> some View {
        if let coverage = purchase.coverage {
            if coverage.eligible {
                LabeledContent("Status", value: "Covered")
                LabeledContent("Covered until", value: Self.shortDate(coverage.coveredUntil))
                LabeledContent("Pays up to", value: Self.money(coverage.payoutCapCents))
                // The threshold in the buyer's terms. "0.5" is our unit; "half a
                // grade point" is the thing they can picture.
                Text("Covered if the item grades at least \(Self.gradePoints(coverage.gradeDeltaThreshold)) below its certificate.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                LabeledContent("Status", value: "Not covered")
                Text(Self.ineligibleCopy(coverage.ineligibleReason))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } else {
            // Deliberately NOT "Not covered". No snapshot was taken, so we do
            // not know, and saying no would be a confident wrong answer to the
            // one question this screen exists to answer.
            LabeledContent("Status", value: "Not worked out yet")
            Text("We take a coverage snapshot when a purchase is linked to a certificate. This one doesn't have one yet.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        if let claim = purchase.claim {
            LabeledContent("Claim", value: Self.claimStatusCopy(claim.status))
            if claim.remedyCents > 0 {
                LabeledContent("Paid out", value: Self.money(claim.remedyCents))
            }
            if claim.remedyCredits > 0 {
                LabeledContent("Credits", value: "\(claim.remedyCredits)")
            }
        }
    }

    private var emptySection: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text("No linked purchases yet.")
                    .font(.subheadline)
                Text("Link a purchase to its certificate and we'll work out its coverage: how long you're protected and how much it pays.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
        }
    }

    private var lockedSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text("Your plan doesn't include the purchase guarantee.")
                    .font(.subheadline)
                Text("The guarantee pays out when an item arrives graded below its certificate. It comes with Guard and above, and your trust level adds days to the window.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
        }
    }

    private func failedSection(_ message: String) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                // Names what is unaffected first. A coverage screen that will
                // not load must not read as coverage that has lapsed.
                Text("We couldn't load your coverage. It's unaffected - this is a display problem.")
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

    static func money(_ cents: Int?) -> String {
        guard let cents else { return "-" }
        return String(format: "$%.2f", Double(cents) / 100)
    }

    static func shortDate(_ iso: String?) -> String {
        guard let date = BuyerDate.parse(iso) else { return "-" }
        return date.formatted(date: .abbreviated, time: .omitted)
    }

    /// 0.5 is "half a grade point". A buyer has no reason to know our units.
    static func gradePoints(_ threshold: Double) -> String {
        if threshold == 0.5 { return "half a grade point" }
        if threshold == 1 { return "1 grade point" }
        return "\(Self.trimmed(threshold)) grade points"
    }

    private static func trimmed(_ value: Double) -> String {
        value == value.rounded() ? "\(Int(value))" : String(format: "%.1f", value)
    }

    /// The machine reason in the buyer's words. Mirrors the web's ineligibleCopy
    /// (src/pages/buyer/guarantee.tsx) — the REASONS are policy and live on the
    /// server; only the sentences are here, and a sentence is not a rule.
    static func ineligibleCopy(_ reason: String?) -> String {
        switch reason {
        case "plan_not_covered":
            return "Your plan didn't include the guarantee when you bought this."
        case "window_expired":
            return "The coverage window for this purchase has closed."
        case "no_certificate":
            return "This purchase isn't linked to a verifiable certificate."
        default:
            return "This purchase isn't covered."
        }
    }

    static func claimStatusCopy(_ status: String) -> String {
        switch status {
        case "pending", "submitted": return "Under review"
        case "approved": return "Approved"
        case "paid": return "Paid"
        case "rejected", "denied": return "Declined"
        default: return status.capitalized
        }
    }
}

/// Postgres timestamps come back WITH fractional seconds sometimes and without
/// them other times, and a strict ISO8601DateFormatter returns nil for whichever
/// one it was not configured for — rendering a dash where a date belongs. Same
/// two-formatter idiom as ListingPerformance.parseDate; deliberately not a
/// shared extension on ISO8601DateFormatter, because a global helper named
/// "flexible" is how a third one gets added.
enum BuyerDate {
    private static let withFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let plain = ISO8601DateFormatter()

    static func parse(_ iso: String?) -> Date? {
        guard let iso, !iso.isEmpty else { return nil }
        return withFraction.date(from: iso) ?? plain.date(from: iso)
    }
}
