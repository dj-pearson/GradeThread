import SwiftUI

/// Standardised "You're offline" notice for action surfaces (US-981). Reused by
/// every network-dependent button so the copy + chrome stay consistent and a
/// raw `URLError` description never reaches the user.
///
/// Two intents:
/// - `.blocked` — the action can't run offline, so its button is disabled until
///   reconnect; this notice explains why.
/// - `.queued`  — the action still runs and is saved locally to sync on
///   reconnect (offline-queue paths, e.g. Add Expense); the button stays
///   enabled and this notice reassures the user nothing is lost.
///
/// Renders fine both inside a `Form`/`List` section and inside a plain stack.
struct OfflineNotice: View {
    enum Intent { case blocked, queued }

    var intent: Intent = .blocked
    /// Optional action-specific tail for `.blocked`, e.g. "to publish to eBay".
    /// Ignored by `.queued` (its copy is self-contained).
    var detail: String? = nil

    private var message: String {
        switch intent {
        case .blocked:
            if let detail {
                return "You're offline. Reconnect \(detail)."
            }
            return "You're offline. Reconnect to try again."
        case .queued:
            return "You're offline. We'll save this and sync it when you reconnect."
        }
    }

    private var icon: String {
        intent == .queued ? "arrow.triangle.2.circlepath" : "wifi.slash"
    }

    var body: some View {
        Label(message, systemImage: icon)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(
                Color.secondary.opacity(0.10),
                in: RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous)
            )
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(message)
    }
}

extension NetworkMonitor {
    /// View convenience: `true` only when we positively know we're offline. A
    /// `nil` monitor (SwiftUI previews / unit hosts that don't inject one) is
    /// treated as online so nothing is gated there. Reading the `@Observable`
    /// `isConnected` from a `body` registers a dependency, so a gated button
    /// re-enables automatically within ~1s of reconnecting.
    static func isOffline(_ monitor: NetworkMonitor?) -> Bool {
        monitor?.isConnected == false
    }
}
