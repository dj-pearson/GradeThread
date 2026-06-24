import SwiftUI

/// Shared full-screen "couldn't load" state with a uniform, always-visible
/// retry affordance (US-971; aligns with the empty-state consistency work in
/// US-753). Data screens whose initial load can fail should render this in
/// their `.failed` branch instead of a bare icon + message — so the user can
/// recover in place rather than backing out and re-entering.
///
/// The `retry` closure is async: the button shows its own spinner while it runs
/// and disables itself so a double-tap can't fire two loads. The parent store is
/// expected to clear the error (move its phase off `.failed`) on success, which
/// swaps this view out for the loading/content state.
struct ErrorStateView: View {
    var title: String = "Couldn't load"
    let message: String
    var systemImage: String = "exclamationmark.triangle"
    var retryTitle: String = "Try again"
    let retry: () async -> Void
    /// Optional escape hatch (e.g. "Back") rendered beneath the retry button.
    var secondaryTitle: String? = nil
    var secondaryAction: (() -> Void)? = nil

    @State private var isRetrying = false

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(message)
        } actions: {
            Button {
                AppRouter.haptic()
                Task {
                    isRetrying = true
                    await retry()
                    isRetrying = false
                }
            } label: {
                Group {
                    if isRetrying {
                        ProgressView()
                    } else {
                        Label(retryTitle, systemImage: "arrow.clockwise")
                    }
                }
                .frame(minWidth: 140)
            }
            .buttonStyle(.brandSecondary)
            .disabled(isRetrying)
            .accessibilityLabel(retryTitle)
            // US-1202: the spinner keeps the static label, so tell VoiceOver
            // the button is now loading.
            .accessibilityValue(isRetrying ? "Loading" : "")

            if let secondaryTitle, let secondaryAction {
                Button(secondaryTitle, action: secondaryAction)
                    .buttonStyle(.borderless)
                    .disabled(isRetrying)
            }
        }
    }
}
