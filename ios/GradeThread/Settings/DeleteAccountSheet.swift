import SwiftUI

/// Confirmation flow for permanent account deletion (US-194, App Store
/// Guideline 5.1.1(v)). Requires the user to type the word "delete"
/// before the destructive button enables, then calls
/// ``AuthStore/deleteAccount()`` which runs the `delete_account` RPC and
/// signs out.
struct DeleteAccountSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AuthStore.self) private var authStore

    @State private var confirmationText: String = ""
    @State private var isDeleting = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Label("This can't be undone", systemImage: "exclamationmark.triangle.fill")
                            .font(.brandHeadline)
                            .foregroundStyle(.red)
                        Text("Deleting your account permanently removes your inventory, photos, listings, sales, and marketplace connections from GradeThread. Listings already live on eBay are not affected and must be ended there.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                }

                Section {
                    TextField("Type delete to confirm", text: $confirmationText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                        .disabled(isDeleting)
                } footer: {
                    Text("Type \(Self.confirmationPhrase) in the box above to enable the button.")
                        .font(.footnote)
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "xmark.octagon")
                            .foregroundStyle(.red)
                            .font(.footnote)
                    }
                }

                Section {
                    Button(role: .destructive) {
                        Task { await runDelete() }
                    } label: {
                        HStack {
                            if isDeleting { ProgressView() }
                            Text(isDeleting ? "Deleting…" : "Delete my account")
                                .font(.subheadline.weight(.semibold))
                                .frame(maxWidth: .infinity)
                        }
                        .padding(.vertical, 6)
                    }
                    .disabled(!Self.canDelete(input: confirmationText) || isDeleting)
                }
            }
            .navigationTitle("Delete account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(isDeleting)
                }
            }
        }
        .interactiveDismissDisabled(isDeleting)
    }

    private func runDelete() async {
        guard Self.canDelete(input: confirmationText) else { return }
        isDeleting = true
        errorMessage = nil
        defer { isDeleting = false }
        do {
            try await authStore.deleteAccount()
            HapticFeedback.success()
            // Auth-state stream flips to .signedOut → ProtectedRouteShell
            // swaps to LoginView. Dismiss this sheet so it doesn't linger
            // over the login screen.
            dismiss()
        } catch {
            HapticFeedback.error()
            errorMessage = "Couldn't delete your account. Check your connection and try again, or contact support@gradethread.com."
        }
    }

    /// The exact word the user must type. Case-insensitive match in
    /// ``canDelete(input:)`` so "Delete" / "DELETE" also pass.
    static let confirmationPhrase = "delete"

    /// Pure gate for the destructive button. Trims whitespace + matches
    /// the phrase case-insensitively. Extracted so the rule is unit-
    /// testable without standing up the SwiftUI view.
    // nonisolated: pure helper with no main-actor state, so the unit test can call
    // it synchronously (View conformance otherwise infers @MainActor).
    nonisolated static func canDelete(input: String) -> Bool {
        input.trimmingCharacters(in: .whitespacesAndNewlines)
            .caseInsensitiveCompare(confirmationPhrase) == .orderedSame
    }
}
