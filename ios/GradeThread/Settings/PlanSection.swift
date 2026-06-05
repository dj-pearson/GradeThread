import SwiftUI

/// Settings "Plan & credits" section: the user's FlipDesk plan, grade
/// credit balance, included grades remaining this month, and a link out to
/// manage billing on the web (Stripe checkout/portal lives there).
struct PlanSection: View {
    @State private var store = PlanStore()
    @State private var showingBilling = false

    private static let billingURL = URL(string: "https://gradethread.com/dashboard/billing")!

    var body: some View {
        Section {
            switch store.phase {
            case .loading:
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Loading plan…").foregroundStyle(.secondary)
                }
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
            Text("Manage your subscription, buy grade credits, and view invoices on the web.")
                .font(.footnote)
        }
        .task { await store.load() }
        .sheet(isPresented: $showingBilling) {
            SafariView(url: Self.billingURL).ignoresSafeArea()
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

        Button {
            AppRouter.haptic()
            showingBilling = true
        } label: {
            Label("Manage plan & billing", systemImage: "creditcard")
        }
    }
}
