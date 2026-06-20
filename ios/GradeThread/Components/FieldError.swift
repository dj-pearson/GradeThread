import SwiftUI

/// US-754: inline field error, mirroring the web `FieldError` — a small red
/// caption with a warning glyph rendered directly beneath an invalid input so
/// the user sees *why* a field is wrong instead of just a greyed-out Save
/// button. The glyph + brand-red color are the visible "this field is invalid"
/// mark; the message is announced separately via `A11yAnnounce` when it appears.
struct FieldError: View {
    let message: String

    init(_ message: String) { self.message = message }

    var body: some View {
        Label {
            Text(message)
        } icon: {
            Image(systemName: "exclamationmark.circle.fill")
        }
        .font(.footnote)
        .foregroundStyle(Color.brandRed)
        // Read as a single phrase to VoiceOver ("warning: <message>").
        .accessibilityElement(children: .combine)
    }
}
