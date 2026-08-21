import GradeThreadCore
import SwiftData
import SwiftUI

/// Home tab: a glanceable snapshot of the business — inventory value,
/// active listings, the trailing-7-day money figures, and a nudge list of
/// aging stock. Reads the local SwiftData mirror via `@Query` (instant,
/// offline-friendly, and auto-updates as sync lands new rows) and reduces
/// it through ``DashboardRollup``.
struct DashboardView: View {
    /// Drives the quick-action buttons (Add sheet / tab switches). Owned by
    /// the shell; we only mutate `selection` / `showingAddSheet`.
    let router: AppRouter

    /// Which of Snap-to-Value (US-613), ScoutAI and Item Prospecting (US-1107)
    /// is presented. One optional driving one sheet modifier — see
    /// ``ToolModule``; three separate `.sheet(isPresented:)` modifiers on this
    /// view is what made two of the three flash open and close again.
    @State private var presentedModule: ToolModule?
    /// US-647: post-signup activation checklist.
    @State private var activation = ActivationChecklistStore()

    @Query(sort: \LocalInventoryItem.updatedAt, order: .forward)
    private var items: [LocalInventoryItem]
    @Query private var sales: [LocalSale]

    /// US-693: lets the empty branch tell "first sync still running" apart from
    /// "genuinely no data yet" so a fresh launch shows skeletons, not a
    /// premature Welcome card.
    @Environment(SyncStatusStore.self) private var syncStatus

    private let currency = CurrencyFormatter()

    // US-1263: the home rollup and its aging/graded subsets are memoized in
    // `@State` (rebuilt only when the underlying rows change) instead of being
    // recomputed on every `body` pass. `metrics` alone was read ~8× per pass,
    // each read re-reducing every item and sale on the main actor; `agingItems`
    // and `gradedItems` re-filtered the full table per read too. Same pattern as
    // the US-967 `trendPoints` series below — rebuilt via `.onChange` keyed on a
    // cheap signature of just the fields these rollups consume.
    @State private var metrics: DashboardMetrics = .empty

    /// Oldest-first (the `@Query` sort) on-hand items past the aging
    /// threshold, capped to a short nudge list.
    @State private var agingItems: [LocalInventoryItem] = []

    /// Certified-graded items (for the grades card).
    @State private var gradedItems: [LocalInventoryItem] = []

    var body: some View {
        Group {
            // US-1261: route the empty cache through `display` so an existing
            // user on an offline cold launch sees an unavailable/retry state
            // rather than the first-run Welcome (which looked like their
            // inventory had vanished). See `DashboardView.display`.
            switch display {
            case .content:
                dashboard
            case .loading:
                loadingState
            case .welcome:
                emptyState
            case .unavailable:
                unavailableState
            }
        }
        .navigationTitle("Home")
        .refreshable {
            NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
        }
        .toolModulePresentation($presentedModule, router: router)
        // US-967: rebuild the 14-day trend series only when sales or items
        // change, not on every `body` re-evaluation (where it was read 3×).
        .onChange(of: trendSignature, initial: true) { _, _ in
            trendPoints = DashboardTrend.dailySeries(sales: sales, items: items, days: 14, now: .now)
        }
        // US-1263: rebuild the metrics rollup + aging/graded subsets only when a
        // field they actually read changes, not on every unrelated re-render.
        .onChange(of: derivedSignature, initial: true) { _, _ in
            rebuildRollups()
        }
    }

    /// US-1261: which of the four home surfaces to render for the current
    /// `@Query` snapshot + sync phase. Computed from a PURE decision (testable
    /// without a `ModelContainer`) so the offline-cold-launch path is covered.
    private var display: HomeDisplay {
        DashboardView.display(
            hasItems: !items.isEmpty,
            hasSales: !sales.isEmpty,
            phase: syncStatus.phase
        )
    }

    /// The four mutually-exclusive home surfaces.
    enum HomeDisplay: Equatable {
        /// Real KPI dashboard — the cache has rows.
        case content
        /// Skeletons while the first sync is actively pulling (US-693).
        case loading
        /// First-run Welcome — genuinely empty AND online/synced.
        case welcome
        /// US-1261: offline with an empty cache — we can't tell "no inventory"
        /// from "not synced to this device yet", so show an unavailable/retry
        /// state instead of falsely claiming the user has no items.
        case unavailable
    }

    /// Pure mapping from cache emptiness + sync phase to the home surface.
    ///
    /// The empty cache is ambiguous offline: a brand-new user and an existing
    /// user whose data hasn't reached this device both have zero local rows.
    /// Resolve it by the sync phase — only show the first-run Welcome when we're
    /// genuinely online/synced (`.idle`/`.pending`); treat `.offline` as an
    /// unavailable/retry state, and an in-flight `.syncing`/`.reconnecting` as a
    /// loading state.
    static func display(hasItems: Bool, hasSales: Bool, phase: SyncStatusStore.Phase) -> HomeDisplay {
        if hasItems || hasSales { return .content }
        switch phase {
        case .syncing, .reconnecting:
            return .loading
        case .offline:
            return .unavailable
        case .idle, .pending:
            return .welcome
        }
    }

    /// US-1263: recompute the memoized rollup subsets from the current `@Query`
    /// snapshot. Driven by `.onChange(of: derivedSignature)` so the O(n) reduce
    /// + filters run once per data change instead of on every `body` pass.
    private func rebuildRollups() {
        let now = Date.now
        metrics = DashboardRollup.compute(items: items, sales: sales, now: now)
        agingItems = Array(
            items.lazy
                .filter { DashboardRollup.isAging($0, now: now) }
                .prefix(5)
        )
        gradedItems = items.filter { $0.gradeValue != nil }
    }

    /// Cheap signature over exactly the fields the memoized rollups consume
    /// (`DashboardRollup.compute` + the aging predicate + the graded filter), so
    /// they rebuild when — and only when — one of those inputs changes.
    private var derivedSignature: Int { DashboardView.derivedSignature(items: items, sales: sales) }

    static func derivedSignature(items: [LocalInventoryItem], sales: [LocalSale]) -> Int {
        var hasher = Hasher()
        hasher.combine(items.count)
        for item in items {
            hasher.combine(item.id)
            hasher.combine(item.status)
            hasher.combine(item.updatedAt)
            hasher.combine(item.listingPrice)
            hasher.combine(item.targetPrice)
            hasher.combine(item.acquiredPrice)
            hasher.combine(item.gradeValue)
        }
        hasher.combine(sales.count)
        for sale in sales {
            hasher.combine(sale.inventoryItemId)
            hasher.combine(sale.saleDate)
            hasher.combine(sale.status)
            hasher.combine(sale.salePrice)
            hasher.combine(sale.platformFees)
            hasher.combine(sale.paymentProcessingFees)
            hasher.combine(sale.shippingCollected)
            hasher.combine(sale.shippingCost)
            hasher.combine(sale.gradingCost)
            hasher.combine(sale.otherCosts)
        }
        return hasher.finalize()
    }

    // MARK: - Populated dashboard

    /// US-967: the trailing-14-day daily revenue/profit series, memoized in
    /// `@State`. It's read up to three times per `body` pass (the activity gate,
    /// the header total, the sparkline), and `DashboardTrend.dailySeries` is an
    /// O(n) bucket over every sale plus an item cost-basis map — so recomputing
    /// it per read (and on every unrelated re-render) is wasted main-thread work.
    /// Rebuilt via `.onChange` only when the sales or items actually change.
    @State private var trendPoints: [DashboardTrendPoint] = []

    /// Cheap signature of the inputs `DashboardTrend.dailySeries` consumes: each
    /// sale's bucketing fields plus each item's cost basis.
    private var trendSignature: Int { DashboardView.trendSignature(sales: sales, items: items) }

    static func trendSignature(sales: [LocalSale], items: [LocalInventoryItem]) -> Int {
        var hasher = Hasher()
        hasher.combine(sales.count)
        for sale in sales {
            hasher.combine(sale.inventoryItemId)
            hasher.combine(sale.saleDate)
            hasher.combine(sale.salePrice)
            hasher.combine(sale.platformFees)
        }
        hasher.combine(items.count)
        for item in items {
            hasher.combine(item.id)
            hasher.combine(item.acquiredPrice)
        }
        return hasher.finalize()
    }

    private var dashboard: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if !activation.isDismissed, !activation.allComplete(hasItem: !items.isEmpty) {
                    ActivationChecklistView(router: router, hasItem: !items.isEmpty, store: activation)
                }
                kpiGrid
                if DashboardTrend.hasActivity(trendPoints) { trendCard }
                analyticsCard
                if !gradedItems.isEmpty { gradesCard }
                if !agingItems.isEmpty { agingCard }
                quickActions
            }
            .padding(16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }

    private var trendCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("Revenue · 14 days")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text(currency.formatDisplay(Money.sum(trendPoints) { $0.revenue }))
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(Color.brandNavy)
            }
            TrendSparkline(points: trendPoints)
                .frame(height: 56)
        }
        .padding(16)
        .cardStyle(.flush)
    }

    private var analyticsCard: some View {
        NavigationLink {
            AnalyticsView(router: router)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "chart.bar.xaxis")
                    .font(.title3)
                    .foregroundStyle(Color.brandNavy)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Analytics")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("Profit, sell-through & grade trends")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(16)
            .cardStyle(.flush)
        }
        .buttonStyle(.plain)
    }

    private var gradesCard: some View {
        NavigationLink(value: GradesRoute()) {
            HStack(spacing: 12) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.title3)
                    .foregroundStyle(Color.brandNavy)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Certified grades")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("\(gradedItems.count) graded item\(gradedItems.count == 1 ? "" : "s")\(averageGradeSuffix)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(16)
            .cardStyle(.flush)
        }
        .buttonStyle(.plain)
    }

    private var averageGradeSuffix: String {
        let values = gradedItems.compactMap(\.gradeValue)
        guard !values.isEmpty else { return "" }
        let avg = values.reduce(0, +) / Double(values.count)
        return " · avg \(String(format: "%.1f", avg))"
    }

    private var kpiGrid: some View {
        LazyVGrid(
            columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)],
            spacing: 12
        ) {
            DashboardCard(
                title: "Inventory value",
                value: currency.formatDisplay(metrics.inventoryValue),
                subtitle: "\(metrics.onHandCount) item\(metrics.onHandCount == 1 ? "" : "s") on hand",
                systemImage: "shippingbox.fill",
                tint: .brandNavy
            )
            DashboardCard(
                title: "Listed",
                value: "\(metrics.listedCount)",
                subtitle: "active listing\(metrics.listedCount == 1 ? "" : "s")",
                systemImage: "tag.fill",
                tint: .brandNavy
            )
            DashboardCard(
                title: "Sold · 7 days",
                value: "\(metrics.soldThisWeekCount)",
                subtitle: "\(currency.formatDisplay(metrics.revenueThisWeek)) revenue",
                systemImage: "bag.fill",
                tint: .brandNavy
            )
            DashboardCard(
                title: "Net profit · 7 days",
                value: currency.formatDisplay(metrics.netProfitThisWeek),
                subtitle: "after fees + cost",
                systemImage: "chart.line.uptrend.xyaxis",
                tint: metrics.netProfitThisWeek < 0 ? .brandRed : .brandEmerald
            )
        }
    }

    private var agingCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Label("Aging stock", systemImage: "clock.badge.exclamationmark")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(metrics.agingCount)")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)

            Divider().padding(.leading, 14)

            ForEach(Array(agingItems.enumerated()), id: \.element.id) { index, item in
                NavigationLink(value: item) {
                    AgingRow(item: item)
                }
                .buttonStyle(.plain)
                if index < agingItems.count - 1 {
                    Divider().padding(.leading, 14)
                }
            }
        }
        .cardStyle(.flush)
    }

    private var quickActions: some View {
        VStack(spacing: 10) {
            // US-690: brand button styles for the primary/secondary CTAs.
            Button {
                AppRouter.haptic()
                router.showingAddSheet = true
            } label: {
                Label("Add an item", systemImage: "plus.circle.fill")
            }
            .buttonStyle(.brandPrimary)

            // US-613: Snap-to-Value — the free "what's it worth?" scan.
            Button {
                AppRouter.haptic()
                presentedModule = .snap
            } label: {
                Label("What's it worth?", systemImage: "sparkles")
            }
            .buttonStyle(.brandSecondary)

            // US-1107: Item Prospecting — snap an item in-store, get comps.
            Button {
                AppRouter.haptic()
                presentedModule = .prospect
            } label: {
                Label("Prospect an item", systemImage: "viewfinder.circle")
            }
            .buttonStyle(.brandSecondary)

            // ScoutAI — find underpriced listings to buy and flip.
            Button {
                AppRouter.haptic()
                presentedModule = .scout
            } label: {
                Label("Scout deals", systemImage: "binoculars")
            }
            .buttonStyle(.brandSecondary)

            Button {
                AppRouter.haptic()
                router.selection = .inventory
            } label: {
                Label("View inventory", systemImage: "shippingbox")
            }
            .buttonStyle(.brandSecondary)
        }
        .padding(.top, 4)
    }

    // MARK: - Loading (first-sync) state

    /// US-693: skeleton KPI grid shown while the initial sync is in flight so
    /// the home tab doesn't flash a Welcome card before data lands.
    private var loadingState: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                LazyVGrid(
                    columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)],
                    spacing: 12
                ) {
                    ForEach(0..<4, id: \.self) { _ in
                        VStack(alignment: .leading, spacing: 8) {
                            SkeletonLine(widthFraction: 0.5, height: 11)
                            SkeletonLine(widthFraction: 0.7, height: 20)
                            SkeletonLine(widthFraction: 0.4, height: 10)
                        }
                        .frame(maxWidth: .infinity, minHeight: 92, alignment: .leading)
                        .padding(16)
                        .cardStyle(.flush)
                    }
                }
                SkeletonBlock(cornerRadius: CornerRadius.card).frame(height: 96)
            }
            .padding(16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .accessibilityLabel("Loading your dashboard")
    }

    // MARK: - Unavailable (offline, empty cache) state

    /// US-1261: shown when the cache is empty AND we're offline — an existing
    /// user opening the app before sync populates would otherwise see the
    /// first-run Welcome and think their inventory vanished. Reuses the shared
    /// `ErrorStateView` so the retry affordance matches the rest of the app; the
    /// retry re-requests an inventory pull (same as pull-to-refresh).
    private var unavailableState: some View {
        ErrorStateView(
            title: "Dashboard unavailable",
            message: "You're offline and your inventory hasn't synced to this device yet. Reconnect to load it.",
            systemImage: "wifi.slash",
            retryTitle: "Retry",
            retry: {
                NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
            }
        )
        .background(Color(uiColor: .systemGroupedBackground))
    }

    // MARK: - Empty (first-run) state

    /// US-647: the empty state links into the same activation steps (the
    /// checklist) so a brand-new user has a guided path, not just a CTA.
    private var emptyState: some View {
        ScrollView {
            VStack(spacing: 20) {
                if !activation.isDismissed {
                    ActivationChecklistView(router: router, hasItem: false, store: activation)
                }
                VStack(spacing: 10) {
                    Image(systemName: "shippingbox")
                        .font(.system(size: 48, weight: .light))
                        .foregroundStyle(Color.brandNavy)
                    Text("Welcome to GradeThread")
                        .font(.brandTitle2)
                    Text("Capture an item to start building your inventory. Your value, listings, and sales will show up here.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button {
                        AppRouter.haptic()
                        router.startIntake(.photoFirst)
                    } label: {
                        Label("Capture your first item", systemImage: "camera.fill")
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.brandNavy)
                    .padding(.top, 4)
                }
                .padding(.top, 12)
            }
            .padding(16)
            .frame(maxWidth: .infinity)
        }
        .background(Color(uiColor: .systemGroupedBackground))
    }
}

// MARK: - Subviews

/// A single KPI tile. Fixed height so the 2-column grid stays even when one
/// value wraps.
private struct DashboardCard: View {
    let title: String
    let value: String
    let subtitle: String
    let systemImage: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.caption)
                    .foregroundStyle(tint)
                Text(title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Text(value.isEmpty ? "—" : value)
                .font(.title2.weight(.bold))
                .foregroundStyle(tint)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(subtitle)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, minHeight: 92, alignment: .leading)
        .padding(16)
        .cardStyle(.flush)
    }
}

/// One row in the aging-stock nudge list.
private struct AgingRow: View {
    let item: LocalInventoryItem

    private var daysIdle: Int {
        Calendar.current.dateComponents([.day], from: item.updatedAt, to: .now).day ?? 0
    }

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title.isEmpty ? "Untitled item" : item.title)
                    .font(.subheadline)
                    .lineLimit(1)
                Text("\(daysIdle) days idle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}
