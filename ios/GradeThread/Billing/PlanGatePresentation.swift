import SwiftUI

/// US-805: app-wide presentation of plan-gate signals. Attach
/// ``planGatePresentation()`` once at the signed-in shell — it observes
/// ``PlanGateNotifier`` and renders:
///   • a hard-cap **upgrade prompt** sheet (``UpgradePromptView``) on a 402, and
///   • a non-blocking **soft banner** (``PlanSoftWarningBanner``) at 80%.
/// Both route into ``PaywallView`` so the user can resolve the limit in place.

// MARK: - Presenter modifier

private struct PlanGatePresenter: ViewModifier {
    @Environment(AuthStore.self) private var authStore
    @State private var notifier = PlanGateNotifier.shared

    private var userId: UUID? {
        if case let .signedIn(user) = authStore.phase { return user.id }
        return nil
    }

    func body(content: Content) -> some View {
        @Bindable var notifier = notifier
        content
            .overlay(alignment: .top) {
                if let warning = notifier.activeWarning {
                    PlanSoftWarningBanner(
                        warning: warning,
                        // "See plans" promotes the soft warning into the same
                        // upgrade prompt (one sheet — stacking sheet modifiers
                        // flickers; see PlanSection). The prompt then routes on
                        // into PaywallView.
                        onSeePlans: {
                            notifier.activeWarning = nil
                            notifier.activePrompt = PlanGateError(fromWarning: warning)
                        },
                        onDismiss: { notifier.activeWarning = nil }
                    )
                    // Auto-dismiss after a few seconds so it never lingers; keyed
                    // on the warning so a new cap restarts the timer.
                    .task(id: warning.id) {
                        try? await Task.sleep(nanoseconds: 8_000_000_000)
                        if notifier.activeWarning?.id == warning.id {
                            notifier.activeWarning = nil
                        }
                    }
                    .zIndex(1)
                }
            }
    }
}

extension View {
    /// Attach the plan-gate SOFT BANNER to the signed-in shell.
    ///
    /// US-2925: this used to also carry the hard-cap upgrade prompt as its own
    /// `.sheet`, which made it the shell's THIRD sheet modifier — behind the
    /// two-factor sheet and the shell-sheet enum. A view has one sheet slot, so
    /// the three competed and the losers presented and tore down in the same
    /// frame. That is what took "What's it worth?" and "Prospect an item" down
    /// with it: both are presented as a sheet from the Dashboard, and a
    /// contested slot on their ancestor collapsed the whole stack back to the
    /// tab.
    ///
    /// The prompt now lives in `ContentView.ShellSheet.planGate`, in the shell's
    /// single slot, bridged from ``PlanGateNotifier/activePrompt``. The banner
    /// stays here because an `.overlay` is not a presentation and contends with
    /// nothing.
    func planGatePresentation() -> some View {
        modifier(PlanGatePresenter())
    }
}

// MARK: - Upgrade prompt (hard 402 cap)

/// Sheet shown when a hard cap blocks an action. Surfaces the limit, current
/// usage, and the recommended tier, with a button into ``PaywallView``.
/// Dismissable — the underlying flow isn't dead-ended; the user can close this
/// and keep working elsewhere.
struct UpgradePromptView: View {
    let gate: PlanGateError
    let userId: UUID?

    @Environment(\.dismiss) private var dismiss
    @State private var showPaywall = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.lg) {
                    header
                    if let detail = gate.usageDetail {
                        usageRow(detail)
                    }
                    recommendationCard
                    Spacer(minLength: 0)
                }
                .padding(Spacing.lg)
            }
            .navigationTitle("Upgrade")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Not now") { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if userId != nil {
                    Button {
                        AppRouter.haptic()
                        showPaywall = true
                    } label: {
                        Text(gate.recommendedTierLabel.map { "See \($0) & plans" } ?? "See plans")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.brandNavy)
                    .padding(Spacing.lg)
                    .background(.bar)
                }
            }
            .navigationDestination(isPresented: $showPaywall) {
                if let userId {
                    PaywallView(userId: userId)
                }
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            Image(systemName: gate.isFeatureLock ? "lock.circle.fill" : "chart.bar.fill")
                .font(.system(size: 40))
                .foregroundStyle(Color.brandRed)
            Text(gate.title)
                .font(.title2.weight(.bold))
            Text(gate.recommendation)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func usageRow(_ detail: String) -> some View {
        HStack(spacing: Spacing.sm) {
            Image(systemName: "gauge.with.dots.needle.67percent")
                .foregroundStyle(Color.brandNavy)
            Text(detail)
                .font(.subheadline.weight(.medium))
            Spacer()
        }
        .padding(Spacing.md)
        .frame(maxWidth: .infinity)
        .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder
    private var recommendationCard: some View {
        if let tier = gate.recommendedTierLabel {
            HStack(spacing: Spacing.sm) {
                Image(systemName: "sparkles")
                    .foregroundStyle(Color.brandEmerald)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Recommended plan")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(tier)
                        .font(.headline)
                }
                Spacer()
            }
            .padding(Spacing.md)
            .frame(maxWidth: .infinity)
            .background(Color.brandEmerald.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
        }
    }
}

// MARK: - Soft warning banner (80% X-Plan-Warning)

/// Slim, non-blocking banner shown when a cap crosses the user's usage-alert
/// threshold. Mirrors the shell's status strips; tinted amber for "heads up".
struct PlanSoftWarningBanner: View {
    let warning: PlanWarning
    let onSeePlans: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: Spacing.sm) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.footnote)
            VStack(alignment: .leading, spacing: 1) {
                Text("\(warning.pctWhole)% of your \(warning.capLabel) limit used")
                    .font(.footnote.weight(.semibold))
                Text("\(warning.used) of \(warning.limit)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("See plans", action: onSeePlans)
                .font(.footnote.weight(.semibold))
                .buttonStyle(.plain)
                .foregroundStyle(Color.brandNavy)
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, Spacing.md)
        .padding(.vertical, Spacing.sm)
        .background(.regularMaterial)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.brandAmber).frame(height: 2)
        }
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
        .padding(.horizontal, Spacing.md)
        .transition(.move(edge: .top).combined(with: .opacity))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(warning.pctWhole) percent of your \(warning.capLabel) limit used. See plans to upgrade.")
    }
}
