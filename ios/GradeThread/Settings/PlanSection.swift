import SwiftUI

/// Settings "Plan & credits" section: the user's FlipDesk plan, grade
/// credit balance, included grades remaining this month, and a link out to
/// manage billing on the web (Stripe checkout/portal lives there).
struct PlanSection: View {
    @Environment(AuthStore.self) private var authStore
    @State private var store = PlanStore()
    @State private var activeSheet: ActiveSheet?

    private static let billingURL = URL(string: "https://gradethread.com/dashboard/billing")!

    /// A single sheet selector. Stacking multiple `.sheet(isPresented:)`
    /// modifiers on one view makes SwiftUI tear the presentation down the
    /// instant either toggles — the sheet flashes open and immediately
    /// dismisses. One `.sheet(item:)` (like ProfileSection) presents reliably.
    private enum ActiveSheet: Identifiable {
        case paywall(UUID)
        case billing

        var id: String {
            switch self {
            case let .paywall(userId): return "paywall-\(userId.uuidString)"
            case .billing: return "billing"
            }
        }
    }

    private var userId: UUID? {
        if case let .signedIn(user) = authStore.phase { return user.id }
        return nil
    }

    var body: some View {
        Section {
            switch store.phase {
            case .loading:
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(0..<3, id: \.self) { _ in
                        HStack {
                            SkeletonLine(widthFraction: 0.35, height: 12)
                            Spacer()
                            SkeletonBlock(cornerRadius: 6)
                                .frame(width: 64, height: 14)
                        }
                    }
                }
                .padding(.vertical, 4)
            case let .ready(info):
                readyRows(info)
            case let .failed(message):
                VStack(alignment: .leading, spacing: 6) {
                    Text("Couldn't load your plan.")
                        .font(.subheadline)
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button("Try again") { Task { await store.load() } }
                        .font(.subheadline)
                }
            }
        } header: {
            Text("Plan & credits")
        } footer: {
            Text("Buy grade credits or change your plan with “See plans & credits” above. View past invoices on the web.")
                .font(.footnote)
        }
        .task { await store.load() }
        .sheet(item: $activeSheet) { sheet in
            switch sheet {
            case let .paywall(userId):
                NavigationStack { PaywallView(userId: userId) }
            case .billing:
                SafariView(url: Self.billingURL).ignoresSafeArea()
            }
        }
    }

    @ViewBuilder
    private func readyRows(_ info: PlanStore.PlanInfo) -> some View {
        LabeledContent("Plan", value: (info.flipdesk_plan ?? "free").capitalized)

        LabeledContent("Grade credits", value: "\(info.grade_credit_balance ?? 0)")

        if let usage = GradePlanLimits.includedUsage(
            plan: info.flipdesk_plan,
            gradesUsed: info.grades_used_this_month,
            resetAt: info.grade_reset_at
        ) {
            let remaining = max(0, usage.cap - usage.used)
            LabeledContent(
                "Included grades",
                value: "\(remaining) of \(usage.cap) left this month"
            )
        }

        if let userId {
            Button {
                AppRouter.haptic()
                activeSheet = .paywall(userId)
            } label: {
                Label("See plans & credits", systemImage: "sparkles")
            }
        }

        Button {
            AppRouter.haptic()
            activeSheet = .billing
        } label: {
            Label("Manage plan & billing", systemImage: "creditcard")
        }
    }
}
