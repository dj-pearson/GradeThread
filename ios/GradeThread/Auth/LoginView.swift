import AuthenticationServices
import SwiftUI

/// Email/password + Sign in with Apple + Continue with Google. A single
/// view handles both sign-in and sign-up via the `mode` toggle; the
/// surrounding chrome is identical, only the call site changes.
struct LoginView: View {
    enum Mode: String, CaseIterable, Identifiable {
        case signIn = "Sign in"
        case signUp = "Sign up"
        var id: String { rawValue }
    }

    @Environment(AuthStore.self) private var authStore

    @State private var mode: Mode = .signIn
    @State private var email = ""
    @State private var password = ""
    @State private var fullName = ""

    @State private var isSubmitting = false
    @State private var showingPasswordReset = false
    @State private var infoMessage: String?

    private let appleCoordinator = SignInWithAppleCoordinator()

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                header

                Picker("", selection: $mode) {
                    ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)

                fields

                primaryButton

                divider

                socialButtons

                if let infoMessage {
                    Text(infoMessage)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                if let error = authStore.lastError {
                    Text(error.localizedDescription)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(.horizontal, 24)
            .padding(.top, 24)
            .padding(.bottom, 40)
        }
        .background(Color(uiColor: .systemBackground))
        .sheet(isPresented: $showingPasswordReset) {
            if let url = URL(string: "https://gradethread.com/auth/reset-password") {
                SafariView(url: url).ignoresSafeArea()
            }
        }
        .disabled(isSubmitting)
    }

    // MARK: - Sections

    private var header: some View {
        VStack(spacing: 8) {
            Text("GradeThread")
                .font(.largeTitle.weight(.bold))
                .foregroundStyle(Color.brandNavy)
            Text("AI-powered condition grading + the reseller workspace.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.top, 24)
    }

    @ViewBuilder
    private var fields: some View {
        VStack(spacing: 12) {
            if mode == .signUp {
                TextField("Full name", text: $fullName)
                    .textContentType(.name)
                    .textInputAutocapitalization(.words)
                    .textFieldStyle(.roundedBorder)
            }
            TextField("Email", text: $email)
                .keyboardType(.emailAddress)
                .textContentType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)
            SecureField("Password", text: $password)
                .textContentType(mode == .signUp ? .newPassword : .password)
                .textFieldStyle(.roundedBorder)

            if mode == .signIn {
                HStack {
                    Spacer()
                    Button("Forgot password?") {
                        Task { await sendPasswordReset() }
                    }
                    .font(.footnote)
                    .foregroundStyle(Color.brandNavy)
                }
            }
        }
    }

    private var primaryButton: some View {
        Button {
            Task { await submit() }
        } label: {
            Group {
                if isSubmitting {
                    ProgressView().tint(.white)
                } else {
                    Text(mode == .signIn ? "Sign in" : "Create account")
                        .font(.headline)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(Color.brandNavy)
            .foregroundStyle(.white)
            .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
        }
        .disabled(!canSubmit || isSubmitting)
        .opacity(!canSubmit || isSubmitting ? 0.5 : 1)
    }

    private var divider: some View {
        HStack(spacing: 12) {
            line
            Text("or").font(.caption).foregroundStyle(.secondary)
            line
        }
    }

    private var line: some View {
        Rectangle()
            .fill(.secondary.opacity(0.3))
            .frame(height: 1)
    }

    private var socialButtons: some View {
        VStack(spacing: 10) {
            SignInWithAppleButton { request in
                // The actual nonce + request shaping happens inside the
                // coordinator. Returning unmodified here is fine — the
                // coordinator path is the one we drive on tap.
                _ = request
            } onCompletion: { _ in }
                .signInWithAppleButtonStyle(.black)
                .frame(height: 48)
                .allowsHitTesting(false)
                .overlay(
                    // We intentionally intercept the system button's tap
                    // because the SwiftUI variant doesn't expose the nonce
                    // handshake we need for Supabase.
                    Color.clear.contentShape(Rectangle())
                        .onTapGesture {
                            Task { await startAppleFlow() }
                        }
                )

            Button {
                Task { await authStore.continueWithGoogle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "globe")
                    Text("Continue with Google")
                        .font(.headline)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(Color(uiColor: .secondarySystemBackground))
                .foregroundStyle(.primary)
                .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
            }
        }
    }

    // MARK: - Actions

    private var canSubmit: Bool {
        !email.trimmingCharacters(in: .whitespaces).isEmpty
        && password.count >= 6
    }

    private func submit() async {
        guard canSubmit, !isSubmitting else { return }
        isSubmitting = true
        defer { isSubmitting = false }

        infoMessage = nil
        let trimmedEmail = email.trimmingCharacters(in: .whitespaces)
        switch mode {
        case .signIn:
            await authStore.signIn(email: trimmedEmail, password: password)
        case .signUp:
            await authStore.signUp(
                email: trimmedEmail,
                password: password,
                fullName: fullName.isEmpty ? nil : fullName
            )
            // If we got no error, Supabase has either signed the user in or
            // sent a confirmation email. Surface a one-liner — the auth-state
            // stream will flip phase once they confirm.
            if authStore.lastError == nil {
                infoMessage = "Check your email to confirm your account."
            }
        }
    }

    private func sendPasswordReset() async {
        let trimmed = email.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else {
            infoMessage = "Enter your email above first, then tap Forgot password."
            return
        }
        await authStore.resetPassword(email: trimmed)
        if authStore.lastError == nil {
            // Open the web reset page in case the user prefers to handle it
            // there. The deep link in the email also lands here.
            showingPasswordReset = true
            infoMessage = "We sent you a reset link."
        }
    }

    private func startAppleFlow() async {
        do {
            let credential = try await appleCoordinator.start()
            await authStore.signInWithApple(
                idToken: credential.idToken,
                nonce: credential.unhashedNonce,
                fullName: credential.fullName
            )
        } catch {
            // ASAuthorizationError.canceled is fine to swallow silently;
            // anything else routes through the visible error region.
            if let asError = error as? ASAuthorizationError,
               asError.code == .canceled {
                return
            }
            authStore.lastError = error
        }
    }
}

#Preview {
    LoginView()
        .environment(AuthStore())
}
