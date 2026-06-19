import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// Shared keyboard-dismissal helpers (US-969).
///
/// `.decimalPad`/`.numberPad` keyboards have no Return key, so a field using
/// one is otherwise impossible to dismiss without a custom accessory. Rather
/// than copy-paste a "Done" button per screen, apply ``View/keyboardDoneToolbar(_:)``
/// once at a form/scroll root.
enum KeyboardDismissal {
    /// Resign whatever is currently first responder, dismissing the keyboard.
    /// Field-agnostic, so a single shared "Done" button works for every input
    /// on a screen without threading a `@FocusState` binding through.
    static func dismiss() {
        #if canImport(UIKit)
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil
        )
        #endif
    }
}

/// Adds a trailing "Done" button to the keyboard accessory bar that dismisses
/// the keyboard for any focused field on the screen.
struct KeyboardDoneToolbar: ViewModifier {
    let title: String

    func body(content: Content) -> some View {
        content.toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button(title) { KeyboardDismissal.dismiss() }
                    .fontWeight(.semibold)
                    .tint(Color.brandNavy)
                    .accessibilityHint("Dismisses the keyboard")
            }
        }
    }
}

extension View {
    /// Add a shared "Done" button above the keyboard that dismisses it for any
    /// focused field — essential for `.decimalPad`/`.numberPad` fields, which
    /// have no Return key to dismiss with (US-969).
    ///
    /// Apply ONCE per screen, at the `Form`/`List`/`ScrollView` root: SwiftUI
    /// aggregates `.keyboard`-placement toolbars across the responder hierarchy,
    /// so applying it on several fields in the same screen renders duplicate
    /// "Done" buttons. It does not affect VoiceOver content focus order.
    func keyboardDoneToolbar(_ title: String = "Done") -> some View {
        modifier(KeyboardDoneToolbar(title: title))
    }
}
