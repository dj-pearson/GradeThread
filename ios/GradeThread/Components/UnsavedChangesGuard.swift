import SwiftUI

/// US-3220 — stops an accidental swipe-down from silently throwing away a
/// half-filled form.
///
/// A sheet with typed work in it (an expense with a scanned receipt attached, a
/// mileage trip, a new sourcing location, a pricing rule) dismisses on a
/// downward drag by default, and SwiftUI gives no warning and keeps no draft —
/// the seller lands back on the list with everything they typed gone. The item
/// canvas has guarded against this since US-1513; this is the same protection,
/// packaged so a form sheet gets it in two lines.
///
/// Two halves, both required:
///  - `interactiveDismissDisabled(isDirty)` so the drag can't discard work;
///  - a confirmation on the explicit Cancel, so the deliberate way out still
///    works and says what it costs.
struct UnsavedChangesGuard: ViewModifier {
    let isDirty: Bool
    @Binding var showingDiscard: Bool
    let onDiscard: () -> Void

    func body(content: Content) -> some View {
        content
            .interactiveDismissDisabled(isDirty)
            .confirmationDialog(
                "Discard your changes?",
                isPresented: $showingDiscard,
                titleVisibility: .visible
            ) {
                Button("Discard", role: .destructive, action: onDiscard)
                Button("Keep editing", role: .cancel) {}
            } message: {
                Text("What you typed here isn't saved yet.")
            }
    }
}

extension View {
    /// Guards a form sheet's unsaved work. Pair with ``CancelFormButton``.
    func unsavedChangesGuard(
        isDirty: Bool,
        showingDiscard: Binding<Bool>,
        onDiscard: @escaping () -> Void
    ) -> some View {
        modifier(
            UnsavedChangesGuard(isDirty: isDirty, showingDiscard: showingDiscard, onDiscard: onDiscard)
        )
    }
}

/// The Cancel button that belongs with ``UnsavedChangesGuard``: it dismisses
/// straight away on an untouched form and asks first once there's work to lose.
struct CancelFormButton: View {
    let isDirty: Bool
    @Binding var showingDiscard: Bool
    let dismiss: () -> Void

    var body: some View {
        Button("Cancel") {
            if isDirty {
                showingDiscard = true
            } else {
                dismiss()
            }
        }
    }
}
