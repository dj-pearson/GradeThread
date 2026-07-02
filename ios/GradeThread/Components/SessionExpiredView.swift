import SwiftUI

/// US-1522: re-sign-in placeholder shown when a sheet's content requires a user
/// id but the session expired. Prevents a BLANK sheet (an `if let userId` with no
/// `else`) — the user gets an actionable prompt and a way to dismiss instead of
/// an empty modal. Mirrors the inline pattern in `PhotoIntakeView`.
struct SessionExpiredView: View {
    var message: String = "Your session expired. Sign in again to continue."
    var onDismiss: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("Sign in again", systemImage: "person.crop.circle.badge.exclamationmark")
        } description: {
            Text(message)
        } actions: {
            Button("OK", action: onDismiss)
                .buttonStyle(.borderedProminent)
        }
    }
}
