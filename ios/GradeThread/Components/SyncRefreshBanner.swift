import SwiftUI

/// US-3219 — shared pull-to-refresh plumbing for every tab backed by the
/// offline cache.
///
/// Four screens (Home, Money, Profit by item, Sales) used to pull-to-refresh by
/// posting `.inventoryPullRequested` and returning immediately. Two things were
/// wrong with that: the spinner vanished the instant the finger lifted (the
/// closure had nothing to await), and a failed pull was completely silent, so a
/// seller offline or hitting a server error saw yesterday's numbers with no hint
/// they were stale. Inventory, Grades and Analytics already awaited the real
/// ``SyncEngine/sync()`` and flashed a banner (US-643/US-1021/US-1026) — this is
/// that behavior, extracted once instead of copied a seventh time.
enum SyncRefresh {

    /// Runs a real sync and returns a user-facing failure message, or `nil` when
    /// the pull succeeded. Awaiting this from `.refreshable` keeps the spinner
    /// on screen for the duration of the actual pull.
    ///
    /// When the engine hasn't booted yet (very early launch) it falls back to
    /// posting `.inventoryPullRequested` so the gesture still does something —
    /// that path can't report an outcome, so it reports success.
    static func run(_ engine: SyncEngine?) async -> String? {
        guard let engine else {
            await MainActor.run {
                NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
            }
            return nil
        }
        if case let .failed(message) = await engine.sync() { return message }
        return nil
    }

    /// US-1021: composed VoiceOver string for a pull-to-refresh failure. Pure +
    /// static so it's unit-testable (the `UIAccessibility.post` side effect
    /// no-ops without VoiceOver and isn't).
    static func failureAnnouncement(_ message: String) -> String {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Refresh failed." : "Refresh failed. \(trimmed)"
    }
}

/// Transient red capsule shown at the bottom of a screen whose pull-to-refresh
/// failed. Self-clearing after `dismissAfter`, so it never blocks content.
struct SyncRefreshBanner: View {
    let message: String?
    var dismissAfter: Duration = .seconds(3.5)
    let onDismiss: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if let message {
            Text(message)
                .font(.footnote.weight(.medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Color.brandRed, in: Capsule())
                .padding(.bottom, 24)
                .shadow(radius: 6, y: 2)
                .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                .task(id: message) {
                    try? await Task.sleep(for: dismissAfter)
                    guard !Task.isCancelled else { return }
                    withAnimation(ReducedMotion.animation(.default)) { onDismiss() }
                }
        }
    }
}

extension View {
    /// Attaches the shared failure banner to the bottom of this view.
    func syncRefreshBanner(_ message: Binding<String?>) -> some View {
        overlay(alignment: .bottom) {
            SyncRefreshBanner(message: message.wrappedValue) { message.wrappedValue = nil }
        }
    }

    /// Pull-to-refresh that awaits a real sync and reports a failure into
    /// `error`, with the haptic + VoiceOver announcement the Inventory tab has
    /// had since US-1021. Pair with ``syncRefreshBanner(_:)``.
    func syncRefreshable(engine: SyncEngine?, error: Binding<String?>) -> some View {
        refreshable {
            guard let message = await SyncRefresh.run(engine) else { return }
            await MainActor.run {
                withAnimation(ReducedMotion.animation(.default)) { error.wrappedValue = message }
                HapticFeedback.error()
                A11yAnnounce.announce(SyncRefresh.failureAnnouncement(message))
            }
        }
    }
}
