import Charts
import Foundation
import GradeThreadCore
import Observation
import SwiftUI

/// US-1871 — Inventory Equity on the Money tab.
///
/// The capital sitting on the reseller's racks, shown where they already track
/// money. It reuses the US-1869 endpoint verbatim and does no arithmetic the
/// server has not already done: the total, the range, the counts and the three
/// breakdowns all arrive pre-summed in cents, so the phone's only job is to
/// divide by 100 — through ``Money/cents(_:)`` (US-1002), the same rounding the
/// drift-free rollups beside it use, so this card cannot disagree with the Money
/// tab by a penny.
///
/// **Phase 1 is DISPLAY-ONLY** (the US-1868 scope fence). This surface states an
/// estimate and refuses to imply anything else; the exact sentence it carries is
/// the one every other equity surface carries, and
/// `src/test/inventory-equity-scope-fence.test.ts` compares them character for
/// character across web, edge, iOS and Android. A per-platform paraphrase is how
/// one surface ends up promising what the others do not, which is why the copy
/// below is a literal and not a rewrite.
///
/// **Why one file.** Types, transport, store and view live together because the
/// fence discovers surfaces by PATH: every `.swift` file whose name says equity
/// must render the disclosure. Splitting the feature across four equity-named
/// files would mean either four copies of the sentence or four exemptions, and
/// an exemption is how a fence stops fencing.
///
/// **Decoder.** This goes through ``EdgeAPI/sendRaw(method:path:query:bodyData:)``
/// with a PLAIN `JSONDecoder`, not the shared `.convertFromSnakeCase` one. The
/// equity route already emits camelCase, and the breakdown maps are keyed by
/// real brand and category names — a key-converting decoder rewrites those keys,
/// so a brand would render under a mangled label. `sendRaw` still buys the
/// bounded retry, the 401 refresh and the US-1213 plan-gate interception.

// MARK: - Copy

/// The one sentence, verbatim.
///
/// Mirrors `EQUITY_ESTIMATE_DISCLOSURE` in `src/lib/inventory-equity-disclosure.ts`.
/// It is a single unbroken literal on purpose: the guard normalizes whitespace
/// but not Swift's `+` concatenation, so a wrapped literal would read as a
/// paraphrase to the only thing that checks.
enum InventoryEquityCopy {
    static let estimateDisclosure = "An estimate for planning only, from sold comps and your own sell-through — not an appraisal, an offer, or borrowing capacity. Items without a grade or usable comps are excluded."

    static let title = "Inventory Equity"
    static let subtitle = "Estimated liquidation value of your graded inventory."

    /// Shown when nothing on the rack can be valued yet. It points at grading,
    /// because grading more of the rack is the only thing that changes it.
    static let noneValued = "Nothing here can be valued yet. Grading an item is what puts a number on it."

    static let loadFailed = "Couldn't load your inventory equity."
}

// MARK: - Read models

/// One breakdown bucket: money and how many items make it up.
struct InventoryEquityBucket: Decodable, Equatable, Sendable {
    let cents: Int
    let count: Int

    init(cents: Int = 0, count: Int = 0) {
        self.cents = cents
        self.count = count
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cents = try c.decodeIfPresent(Int.self, forKey: .cents) ?? 0
        count = try c.decodeIfPresent(Int.self, forKey: .count) ?? 0
    }

    private enum CodingKeys: String, CodingKey { case cents, count }
}

/// Why items were left out of the total. Both are exclusions, never guesses —
/// an item that cannot be priced honestly moves this count, not the money.
struct InventoryEquityUnvalued: Decodable, Equatable, Sendable {
    let noGrade: Int
    let noComps: Int

    init(noGrade: Int = 0, noComps: Int = 0) {
        self.noGrade = noGrade
        self.noComps = noComps
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        noGrade = try c.decodeIfPresent(Int.self, forKey: .noGrade) ?? 0
        noComps = try c.decodeIfPresent(Int.self, forKey: .noComps) ?? 0
    }

    /// The route emits these two keys in snake_case inside an otherwise
    /// camelCase body, so they are spelled out rather than inferred.
    private enum CodingKeys: String, CodingKey {
        case noGrade = "no_grade"
        case noComps = "no_comps"
    }
}

/// The tenant aggregate, exactly as `aggregateEquity` produced it server-side.
struct InventoryEquityAggregate: Decodable, Equatable, Sendable {
    let totalEquityCents: Int
    let totalLowCents: Int
    let totalHighCents: Int
    let valuedCount: Int
    let unvaluedCount: Int
    let unvaluedByReason: InventoryEquityUnvalued
    let byCategory: [String: InventoryEquityBucket]
    let byBrand: [String: InventoryEquityBucket]
    let byGradeBand: [String: InventoryEquityBucket]

    init(
        totalEquityCents: Int = 0,
        totalLowCents: Int = 0,
        totalHighCents: Int = 0,
        valuedCount: Int = 0,
        unvaluedCount: Int = 0,
        unvaluedByReason: InventoryEquityUnvalued = InventoryEquityUnvalued(),
        byCategory: [String: InventoryEquityBucket] = [:],
        byBrand: [String: InventoryEquityBucket] = [:],
        byGradeBand: [String: InventoryEquityBucket] = [:]
    ) {
        self.totalEquityCents = totalEquityCents
        self.totalLowCents = totalLowCents
        self.totalHighCents = totalHighCents
        self.valuedCount = valuedCount
        self.unvaluedCount = unvaluedCount
        self.unvaluedByReason = unvaluedByReason
        self.byCategory = byCategory
        self.byBrand = byBrand
        self.byGradeBand = byGradeBand
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        totalEquityCents = try c.decodeIfPresent(Int.self, forKey: .totalEquityCents) ?? 0
        totalLowCents = try c.decodeIfPresent(Int.self, forKey: .totalLowCents) ?? 0
        totalHighCents = try c.decodeIfPresent(Int.self, forKey: .totalHighCents) ?? 0
        valuedCount = try c.decodeIfPresent(Int.self, forKey: .valuedCount) ?? 0
        unvaluedCount = try c.decodeIfPresent(Int.self, forKey: .unvaluedCount) ?? 0
        unvaluedByReason = try c.decodeIfPresent(
            InventoryEquityUnvalued.self, forKey: .unvaluedByReason
        ) ?? InventoryEquityUnvalued()
        byCategory = try c.decodeIfPresent(
            [String: InventoryEquityBucket].self, forKey: .byCategory
        ) ?? [:]
        byBrand = try c.decodeIfPresent(
            [String: InventoryEquityBucket].self, forKey: .byBrand
        ) ?? [:]
        byGradeBand = try c.decodeIfPresent(
            [String: InventoryEquityBucket].self, forKey: .byGradeBand
        ) ?? [:]
    }

    private enum CodingKeys: String, CodingKey {
        case totalEquityCents, totalLowCents, totalHighCents
        case valuedCount, unvaluedCount, unvaluedByReason
        case byCategory, byBrand, byGradeBand
    }
}

struct InventoryEquityPayload: Decodable, Equatable, Sendable {
    let currency: String
    /// The seller's own median days-to-sell, or nil when they have no realized
    /// listed → sold history yet.
    let personalSellThroughDays: Double?
    let aggregate: InventoryEquityAggregate

    init(
        currency: String = "USD",
        personalSellThroughDays: Double? = nil,
        aggregate: InventoryEquityAggregate = InventoryEquityAggregate()
    ) {
        self.currency = currency
        self.personalSellThroughDays = personalSellThroughDays
        self.aggregate = aggregate
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        currency = try c.decodeIfPresent(String.self, forKey: .currency) ?? "USD"
        personalSellThroughDays = try c.decodeIfPresent(
            Double.self, forKey: .personalSellThroughDays
        )
        aggregate = try c.decodeIfPresent(
            InventoryEquityAggregate.self, forKey: .aggregate
        ) ?? InventoryEquityAggregate()
    }

    private enum CodingKeys: String, CodingKey {
        case currency, personalSellThroughDays, aggregate
    }
}

/// One nightly snapshot. The trend route is the one part of this feature that
/// speaks snake_case (it returns stored columns), so the keys are spelled out.
struct InventoryEquityTrendPoint: Decodable, Equatable, Sendable, Identifiable {
    let snapshotDate: String
    let totalEquityCents: Int

    var id: String { snapshotDate }

    init(snapshotDate: String = "", totalEquityCents: Int = 0) {
        self.snapshotDate = snapshotDate
        self.totalEquityCents = totalEquityCents
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        snapshotDate = try c.decodeIfPresent(String.self, forKey: .snapshotDate) ?? ""
        totalEquityCents = try c.decodeIfPresent(Int.self, forKey: .totalEquityCents) ?? 0
    }

    private enum CodingKeys: String, CodingKey {
        case snapshotDate = "snapshot_date"
        case totalEquityCents = "total_equity_cents"
    }
}

struct InventoryEquityTrend: Decodable, Equatable, Sendable {
    /// Oldest → newest, as served.
    let points: [InventoryEquityTrendPoint]

    init(points: [InventoryEquityTrendPoint] = []) {
        self.points = points
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        points = try c.decodeIfPresent([InventoryEquityTrendPoint].self, forKey: .points) ?? []
    }

    private enum CodingKeys: String, CodingKey { case points }
}

// MARK: - Display math

/// One row of a breakdown list.
struct InventoryEquityRow: Identifiable, Equatable, Sendable {
    let id: String
    let label: String
    let cents: Int
    let count: Int
    /// Share of the largest bucket in the same list, 0…1 — the bar width.
    let share: Double
}

/// Everything the card computes, as pure functions over the payload.
///
/// There is deliberately no valuation arithmetic here. The server owns the
/// model, and a second implementation on the phone is a second answer waiting
/// to disagree with the first — so this converts, ranks and formats, and
/// nothing else.
enum InventoryEquityMath {

    /// Cents → dollars, rounded the way ``Money`` rounds every other figure on
    /// the Money tab (US-1002). Dividing by 100 in the view instead would let
    /// this card and the realized-net rollup beside it disagree on a `.xx5`.
    static func dollars(_ cents: Int) -> Double {
        Money.cents(Double(cents) / 100)
    }

    /// Items on the rack the endpoint looked at — valued plus excluded.
    static func totalItems(_ aggregate: InventoryEquityAggregate) -> Int {
        aggregate.valuedCount + aggregate.unvaluedCount
    }

    /// Valued ÷ total, 0…1. Nil when there is nothing on the rack at all: an
    /// empty rack has no coverage, and reporting 0% would read as a failure to
    /// value stock that does not exist.
    static func coverage(_ aggregate: InventoryEquityAggregate) -> Double? {
        let total = totalItems(aggregate)
        guard total > 0 else { return nil }
        return Double(aggregate.valuedCount) / Double(total)
    }

    /// The coverage figure as whole percent.
    static func coveragePercent(_ aggregate: InventoryEquityAggregate) -> Int? {
        coverage(aggregate).map { Int(($0 * 100).rounded()) }
    }

    /// Top buckets of one breakdown map, largest first.
    ///
    /// Dictionaries have no order, so ties break on the label — otherwise the
    /// list would reshuffle itself between refreshes with no data change.
    static func rows(
        _ map: [String: InventoryEquityBucket],
        limit: Int = 5
    ) -> [InventoryEquityRow] {
        // Deliberately three statements with an explicit type annotation, not
        // one chained expression. As a single `.map { }.sorted { ternary }
        // .prefix()` chain over an inferred tuple, this blew the Release
        // whole-module type-check budget ("unable to type-check this expression
        // in reasonable time") — the same failure mode PhotoManagerView's body
        // decomposition exists to avoid. The ternary inside the sort closure is
        // what tips it over; naming the type and using an if/return keeps every
        // sub-expression cheap.
        typealias Pair = (label: String, bucket: InventoryEquityBucket)
        let pairs: [Pair] = map.map { (label: $0.key, bucket: $0.value) }
        let ordered: [Pair] = pairs.sorted { lhs, rhs in
            if lhs.bucket.cents == rhs.bucket.cents { return lhs.label < rhs.label }
            return lhs.bucket.cents > rhs.bucket.cents
        }
        let sorted = ordered.prefix(limit)
        let peak = sorted.first?.bucket.cents ?? 0
        return sorted.map { entry in
            InventoryEquityRow(
                id: entry.label,
                label: displayLabel(entry.label),
                cents: entry.bucket.cents,
                count: entry.bucket.count,
                share: peak > 0 ? Double(entry.bucket.cents) / Double(peak) : 0
            )
        }
    }

    /// Sentence-case a server key ("outerwear" → "Outerwear") without touching
    /// the rest, so a brand's own capitalisation survives.
    static func displayLabel(_ key: String) -> String {
        guard let first = key.first else { return key }
        return String(first).uppercased() + key.dropFirst()
    }

    /// Change in the total across the snapshot window, or nil with fewer than
    /// two snapshots (one point is a reading, not a trend).
    static func trendChangeCents(_ points: [InventoryEquityTrendPoint]) -> Int? {
        guard let first = points.first, let last = points.last, points.count >= 2 else {
            return nil
        }
        return last.totalEquityCents - first.totalEquityCents
    }
}

// MARK: - Transport

@MainActor
protocol InventoryEquityReading {
    func summary() async throws -> InventoryEquityPayload
    func trend() async throws -> InventoryEquityTrend
}

@MainActor
final class InventoryEquityService: InventoryEquityReading {

    /// Plain decoder: verbatim keys. See the file header — the breakdown maps
    /// are keyed by real brand and category names, which a converting decoder
    /// would rewrite.
    private let decoder = JSONDecoder()

    init() {}

    func summary() async throws -> InventoryEquityPayload {
        try await get("/api/flipdesk/equity")
    }

    func trend() async throws -> InventoryEquityTrend {
        try await get("/api/flipdesk/equity/trend")
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let data = try await EdgeAPI.shared.sendRaw(method: "GET", path: path, bodyData: nil)
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw EdgeAPIError.decoding(error.localizedDescription)
        }
    }
}

// MARK: - Store

@MainActor
@Observable
final class InventoryEquityStore {

    enum Phase: Equatable {
        case idle
        case loading
        case ready(InventoryEquityPayload)
        /// Nothing to show and nothing the seller can do here: the feature is
        /// switched off for this deployment (404) or their plan does not include
        /// it (402, whose upgrade sheet ``EdgeAPI`` has already presented). Both
        /// render as an absent card, matching web — a card explaining why it is
        /// empty is worse than no card.
        case unavailable
        case failed(String)
    }

    private(set) var phase: Phase = .idle
    private(set) var trend: [InventoryEquityTrendPoint] = []

    private let service: InventoryEquityReading

    init(service: InventoryEquityReading? = nil) {
        self.service = service ?? InventoryEquityService()
    }

    var payload: InventoryEquityPayload? {
        if case .ready(let payload) = phase { return payload }
        return nil
    }

    /// First load. Cheap to call again — an already-ready card does not re-fetch
    /// on every re-appearance of the Money tab.
    func loadIfNeeded() async {
        guard phase == .idle else { return }
        await load()
    }

    func load() async {
        if case .ready = phase {} else { phase = .loading }
        do {
            phase = .ready(try await service.summary())
        } catch let error as EdgeAPIError {
            phase = InventoryEquityStore.isSilent(error)
                ? .unavailable
                : .failed(
                    FriendlyErrorCopy.actionMessage(
                        for: error, fallback: InventoryEquityCopy.loadFailed
                    )
                )
            if case .failed = phase {
                Telemetry.breadcrumb(
                    "inventory equity failed: \(FriendlyErrorCopy.rawDetail(for: error))",
                    category: "equity"
                )
            }
            trend = []
            return
        } catch {
            phase = .failed(
                FriendlyErrorCopy.actionMessage(
                    for: error, fallback: InventoryEquityCopy.loadFailed
                )
            )
            Telemetry.breadcrumb(
                "inventory equity failed: \(FriendlyErrorCopy.rawDetail(for: error))",
                category: "equity"
            )
            trend = []
            return
        }

        // The trend is a garnish on a card that already has its number, so a
        // failure here drops the sparkline and says nothing.
        trend = (try? await service.trend())?.points ?? []
    }

    func refresh() async {
        await load()
    }

    /// Whether an error means "there is nothing here for you" rather than
    /// "something went wrong". A 402 arrives as `.badRequest(detail:)` — there
    /// is no 402 case on the shared enum — so the discriminator is read back off
    /// the detail string, the same shape US-806 uses.
    static func isSilent(_ error: EdgeAPIError) -> Bool {
        switch error {
        case .notFound:
            return true
        case .badRequest(let detail):
            guard let detail else { return false }
            return detail.hasPrefix("FEATURE_LOCKED") || detail.hasPrefix("CAP_REACHED")
        default:
            return false
        }
    }
}

// MARK: - Card

/// The Money-tab card. Renders nothing at all when the feature is off or the
/// plan does not include it.
struct InventoryEquityCard: View {
    @State private var store = InventoryEquityStore()

    private let currency = CurrencyFormatter()

    var body: some View {
        Group {
            switch store.phase {
            case .unavailable:
                EmptyView()
            case .idle, .loading:
                shell { loadingBody }
            case .failed(let message):
                shell { failureBody(message) }
            case .ready(let payload):
                shell { readyBody(payload) }
            }
        }
        .task { await store.loadIfNeeded() }
    }

    // MARK: Chrome

    @ViewBuilder
    private func shell<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "square.stack.3d.up.fill")
                    .scaledIconFont(size: 16, weight: .semibold, relativeTo: .subheadline)
                    .foregroundStyle(Color.brandNavy)
                VStack(alignment: .leading, spacing: 2) {
                    Text(InventoryEquityCopy.title)
                        .font(.subheadline.weight(.semibold))
                    Text(InventoryEquityCopy.subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .cardStyle(.flush)
    }

    private var loadingBody: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProgressView()
            Text("Adding up your rack…")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityLabel("Estimating inventory equity")
    }

    private func failureBody(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(message)
                .font(.footnote)
                .foregroundStyle(.secondary)
            Button {
                Task { await store.refresh() }
            } label: {
                Label("Try again", systemImage: "arrow.clockwise")
                    .font(.caption.weight(.semibold))
                    .frame(minHeight: 44)
            }
            .buttonStyle(.bordered)
            .tint(Color.brandNavy)
        }
    }

    // MARK: Body

    private func readyBody(_ payload: InventoryEquityPayload) -> some View {
        let aggregate = payload.aggregate

        return VStack(alignment: .leading, spacing: 12) {
            total(aggregate)

            if store.trend.count >= 2 {
                sparkline
            }

            coverage(aggregate)

            if aggregate.valuedCount == 0 {
                Text(InventoryEquityCopy.noneValued)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if aggregate.unvaluedByReason.noGrade > 0 {
                gradeMoreButton(aggregate.unvaluedByReason.noGrade)
            }

            if aggregate.valuedCount > 0 {
                NavigationLink {
                    InventoryEquityBreakdownView(aggregate: aggregate)
                } label: {
                    HStack(spacing: 6) {
                        Text("See the breakdown")
                            .font(.caption.weight(.semibold))
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                    }
                    .frame(minHeight: 44)
                }
                .buttonStyle(.plain)
                .foregroundStyle(Color.brandNavy)
            }

            disclosure
        }
    }

    private func total(_ aggregate: InventoryEquityAggregate) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(currency.formatDisplay(InventoryEquityMath.dollars(aggregate.totalEquityCents)))
                .font(.brandTitle)
                .foregroundStyle(Color.brandNavy)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(
                "Range \(currency.formatDisplay(InventoryEquityMath.dollars(aggregate.totalLowCents)))"
                + " – \(currency.formatDisplay(InventoryEquityMath.dollars(aggregate.totalHighCents)))"
            )
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    private var sparkline: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Equity over time")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Chart(store.trend) { point in
                LineMark(
                    x: .value("Day", point.snapshotDate),
                    y: .value("Equity", InventoryEquityMath.dollars(point.totalEquityCents))
                )
                .foregroundStyle(Color.brandNavy)
            }
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .chartYScale(domain: .automatic(includesZero: false))
            .frame(height: 44)
            .accessibilityLabel("Inventory equity trend")
            .accessibilityValue(trendSummary)
        }
    }

    private var trendSummary: String {
        guard let change = InventoryEquityMath.trendChangeCents(store.trend) else {
            return "Not enough history yet"
        }
        let amount = currency.formatDisplay(abs(InventoryEquityMath.dollars(change)))
        let days = store.trend.count
        if change == 0 { return "Unchanged over \(days) days" }
        return change > 0 ? "Up \(amount) over \(days) days" : "Down \(amount) over \(days) days"
    }

    private func coverage(_ aggregate: InventoryEquityAggregate) -> some View {
        let total = InventoryEquityMath.totalItems(aggregate)
        let percent = InventoryEquityMath.coveragePercent(aggregate)
        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Valued coverage")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Spacer()
                Text(percent.map { "\($0)%" } ?? "—")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.brandNavy)
            }
            ProgressView(value: InventoryEquityMath.coverage(aggregate) ?? 0)
                .tint(Color.brandNavy)
            Text("\(aggregate.valuedCount) of \(total) item\(total == 1 ? "" : "s") valued")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Valued coverage")
        .accessibilityValue(
            "\(aggregate.valuedCount) of \(total) items valued"
            + (percent.map { ", \($0) percent" } ?? "")
        )
    }

    /// The organic grading loop: unvalued stock is mostly ungraded stock, and
    /// grading it is what moves both numbers. Mirrors the web card's CTA.
    private func gradeMoreButton(_ count: Int) -> some View {
        Button {
            DeepLinkRouter.post(.inventoryTab)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "sparkles")
                    .scaledIconFont(size: 13, weight: .semibold, relativeTo: .caption)
                Text("Grade \(count) more item\(count == 1 ? "" : "s") to complete your valuation")
                    .font(.caption.weight(.semibold))
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            .frame(minHeight: 44)
            .padding(.horizontal, 10)
            .background(Color.brandNavy.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.brandNavy)
    }

    private var disclosure: some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "info.circle")
                .scaledIconFont(size: 11, weight: .regular, relativeTo: .caption2)
                .foregroundStyle(.secondary)
            Text(InventoryEquityCopy.estimateDisclosure)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - Breakdown

/// Where the equity sits: by category, by brand, and by grade band.
///
/// Read-only by design. Everything here is the same server aggregate the card
/// showed, re-cut three ways, so there is no route by which this screen and the
/// card can disagree.
struct InventoryEquityBreakdownView: View {
    let aggregate: InventoryEquityAggregate

    private let currency = CurrencyFormatter()

    var body: some View {
        List {
            section("By category", rows: InventoryEquityMath.rows(aggregate.byCategory))
            section("By brand", rows: InventoryEquityMath.rows(aggregate.byBrand))
            section("By grade", rows: InventoryEquityMath.rows(aggregate.byGradeBand))

            Section {
                Text(InventoryEquityCopy.estimateDisclosure)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(InventoryEquityCopy.title)
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func section(_ title: String, rows: [InventoryEquityRow]) -> some View {
        Section(title) {
            if rows.isEmpty {
                Text("Nothing valued here yet.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(rows) { row in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(row.label)
                                .font(.subheadline)
                                .lineLimit(1)
                            Spacer()
                            Text(
                                "\(currency.formatDisplay(InventoryEquityMath.dollars(row.cents)))"
                                + " · \(row.count)"
                            )
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                        ProgressView(value: row.share)
                            .tint(Color.brandNavy)
                    }
                    .padding(.vertical, 2)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(row.label)
                    .accessibilityValue(
                        "\(currency.formatDisplay(InventoryEquityMath.dollars(row.cents)))"
                        + ", \(row.count) item\(row.count == 1 ? "" : "s")"
                    )
                }
            }
        }
    }
}
