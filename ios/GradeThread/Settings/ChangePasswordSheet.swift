import SwiftUI

/// In-app change-password form (US-818). Previously the app only offered an
/// email-reset round-trip via web Safari; this lets a signed-in user set a new
/// password directly using their authenticated Supabase session
/// (``AuthStore/updatePassword(newPassword:)``).
///
/// Validation mirrors signup (``LoginView``): a minimum length plus a confirm
/// field that must match. The pure rule lives in ``validate(newPassword:confirm:)``
/// so it's unit-testable without standing up the view.
struct ChangePasswordSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AuthStore.self) private var authStore

    @State private var newPassword: String = ""
    @State private var confirmPassword: String = ""
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var didSucceed = false

    /// Matches the signup minimum in ``LoginView`` (GoTrue's default floor).
    static let minimumLength = 6

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("New password", text: $newPassword)
                        .textContentType(.newPassword)
                        .disabled(isSaving || didSucceed)
                        .accessibilityLabel("New password")
                    SecureField("Confirm new password", text: $confirmPassword)
                        .textContentType(.newPassword)
                        .disabled(isSaving || didSucceed)
                        .accessibilityLabel("Confirm new password")
                } footer: {
                    Text("Choose a new password with at least \(Self.minimumLength) characters. You'll stay signed in on this device.")
                        .font(.footnote)
                }

                if let hint = Self.validate(newPassword: newPassword, confirm: confirmPassword) {
                    Section {
                        Text(hint)
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .accessibilityLabel(hint)
                    }
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "xmark.octagon")
                            .foregroundStyle(.red)
                            .font(.footnote)
                            .accessibilityLabel(errorMessage)
                    }
                }

                if didSucceed {
                    Section {
                        Label("Password updated", systemImage: "checkmark.seal.fill")
                            .foregroundStyle(Color.brandEmerald)
                            .font(.subheadline.weight(.semibold))
                            .accessibilityLabel("Password updated")
                    }
                }

                Section {
                    Button {
                        Task { await save() }
                    } label: {
                        HStack {
                            if isSaving { ProgressView() }
                            Text(isSaving ? "Saving…" : "Update password")
                                .font(.subheadline.weight(.semibold))
                                .frame(maxWidth: .infinity)
                        }
                        .padding(.vertical, 6)
                    }
                    .disabled(!canSave)
                    .accessibilityLabel("Update password")
                }
            }
            .navigationTitle("Change password")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(didSucceed ? "Done" : "Cancel") { dismiss() }
                        .disabled(isSaving)
                }
            }
        }
        .interactiveDismissDisabled(isSaving)
    }

    private var canSave: Bool {
        !isSaving && !didSucceed
            && Self.validate(newPassword: newPassword, confirm: confirmPassword) == nil
    }

    private func save() async {
        guard canSave else { return }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        do {
            try await authStore.updatePassword(newPassword: newPassword)
            HapticFeedback.success()
            didSucceed = true
        } catch {
            HapticFeedback.error()
            // US-1025 convention: never surface the raw Supabase/URLError string;
            // log the raw detail to Sentry and show friendly copy.
            let detail = FriendlyErrorCopy.rawDetail(for: error)
            Telemetry.breadcrumb("Change password failed: \(detail)", category: "auth")
            Telemetry.event("auth_error", props: ["context": "update_password", "detail": detail])
            errorMessage = FriendlyErrorCopy.authMessage(for: error)
        }
    }

    /// Pure validation gate, extracted so it's testable without the view.
    /// Returns a user-facing hint while the input is invalid, or `nil` once the
    /// new password meets the minimum length and the confirm field matches.
    /// Returns `nil` for the empty initial state so we don't nag before typing.
    static func validate(newPassword: String, confirm: String) -> String? {
        if newPassword.isEmpty && confirm.isEmpty { return nil }
        if newPassword.count < minimumLength {
            return "Password must be at least \(minimumLength) characters."
        }
        if confirm.isEmpty { return nil }
        if newPassword != confirm {
            return "Passwords don't match."
        }
        return nil
    }
}
