import AuthenticationServices
import SwiftUI

/// Email/password + Sign in with Apple (Continue with Google is gated off
/// via `AppConfig.googleSignInEnabled` until its flow is fixed). A single
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
    @State private var captchaRequest: CaptchaRequest?

    /// Raw nonce generated in the Apple button's `onRequest` and consumed in
    /// `onCompletion` to prove the identity token wasn't replayed during the
    /// Supabase exchange. The request carries only the SHA-256 hash.
    @State private var appleNonce: String?

    /// In-flight native Turnstile challenge (US-368). Carries the continuation
    /// the presented ``TurnstileSheet`` resumes once a token is solved or the
    /// user cancels.
    private struct CaptchaRequest: Identifiable {
        let id = UUID()
        let siteKey: String
        let continuation: CheckedContinuation<String, Error>
    }

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
                    // US-1025: show friendly, actionable copy — never the raw
                    // Supabase/URLError string. The raw detail is captured to
                    // Sentry at the call site (`reportAuthFailure`).
                    Text(FriendlyErrorCopy.authMessage(for: error))
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
        .sheet(item: $captchaRequest) { request in
            TurnstileSheet(siteKey: request.siteKey) { result in
                captchaRequest = nil
                switch result {
                case .success(let token):
                    request.continuation.resume(returning: token)
                case .failure(let error):
                    request.continuation.resume(throwing: error)
                }
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
                // `.username` (not `.emailAddress`) is the login-identity content
                // type AutoFill pairs with `.password` to surface a saved
                // gradethread.com credential. `.emailAddress` drives contact-email
                // autofill, which competes with the saved-password key.
                .textContentType(.username)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)
                .accessibilityHint(emailValidationHint.map { Text($0) } ?? Text(""))
            if let emailValidationHint {
                validationHint(emailValidationHint)
            }
            SecureField("Password", text: $password)
                .textContentType(mode == .signUp ? .newPassword : .password)
                .textFieldStyle(.roundedBorder)
                .accessibilityHint(passwordValidationHint.map { Text($0) } ?? Text(""))
            if let passwordValidationHint {
                validationHint(passwordValidationHint)
            }

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
                        .font(.brandHeadline)
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

    /// Shared height for both social buttons so the Apple and Google CTAs line
    /// up. The native `SignInWithAppleButton` previously used 48 while the
    /// Google button's `.padding(.vertical, 14)` rendered ~52pt — a visible
    /// mismatch when both were shown.
    private static let socialButtonHeight: CGFloat = 50

    private var socialButtons: some View {
        VStack(spacing: 10) {
            // Drive the nonce handshake through the button's own request /
            // completion closures so SwiftUI owns the presentation. (The older
            // approach — a hit-testing-disabled button with a clear tap overlay
            // firing a hand-rolled ASAuthorizationController — could resolve a
            // detached presentation anchor and fail with AuthorizationError
            // 1000 / .unknown.)
            SignInWithAppleButton(.signIn) { request in
                let nonce = SignInWithAppleCoordinator.randomNonce()
                appleNonce = nonce
                request.requestedScopes = [.fullName, .email]
                request.nonce = SignInWithAppleCoordinator.hashedNonce(nonce)
            } onCompletion: { result in
                handleAppleCompletion(result)
            }
            .signInWithAppleButtonStyle(.black)
            .frame(height: Self.socialButtonHeight)
            .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
            // The native button already exposes the `.button` trait and a
            // localized label, but pin it explicitly so VoiceOver always
            // announces "Sign in with Apple, button" (AC, US-1024).
            .accessibilityLabel(Text("Sign in with Apple"))
            .accessibilityAddTraits(.isButton)

            // Hidden until the native Google OAuth flow is fixed (AppConfig).
            if AppConfig.googleSignInEnabled {
                Button {
                    Task { await authStore.continueWithGoogle() }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "globe")
                        Text("Continue with Google")
                            .font(.brandHeadline)
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: Self.socialButtonHeight)
                    .background(Color(uiColor: .secondarySystemBackground))
                    .foregroundStyle(.primary)
                    .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
                }
            }
        }
    }

    /// A short, red reason rendered directly under the offending field. A plain
    /// `Text` is read by VoiceOver as it scrolls, and the same string is also
    /// attached to the field via `.accessibilityHint` so focusing the field
    /// announces why it's invalid (AC, US-1010).
    private func validationHint(_ message: String) -> some View {
        Text(message)
            .font(.footnote)
            .foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Actions

    /// Non-nil while the entered email is present but malformed; `nil` when the
    /// field is empty (no nagging before the user types) or valid (clears the
    /// hint). Reuses the shared `WorkspaceEmail` regex so the rule matches the
    /// team-invite flow.
    private var emailValidationHint: String? {
        let trimmed = email.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return nil }
        return WorkspaceEmail.isValid(trimmed)
            ? nil
            : "Enter a valid email address, like you@example.com."
    }

    /// Non-nil while a password is being typed but is still too short; `nil`
    /// when empty or once it meets the 6-character minimum.
    private var passwordValidationHint: String? {
        guard !password.isEmpty else { return nil }
        return password.count >= 6 ? nil : "Password must be at least 6 characters."
    }

    private var canSubmit: Bool {
        WorkspaceEmail.isValid(email.trimmingCharacters(in: .whitespaces))
        && password.count >= 6
    }

    private func submit() async {
        guard canSubmit, !isSubmitting else { return }
        isSubmitting = true
        defer { isSubmitting = false }

        infoMessage = nil
        let trimmedEmail = email.trimmingCharacters(in: .whitespaces)

        // US-368: prod GoTrue captcha-gates signup + email/password sign-in.
        // Resolve a Turnstile token first; bail silently if the user cancels.
        let captchaToken: String?
        do {
            captchaToken = try await resolveCaptcha()
        } catch {
            handleCaptchaFailure(error)
            return
        }

        switch mode {
        case .signIn:
            await authStore.signIn(email: trimmedEmail, password: password, captchaToken: captchaToken)
            reportAuthFailure(context: "sign_in")
        case .signUp:
            await authStore.signUp(
                email: trimmedEmail,
                password: password,
                fullName: fullName.isEmpty ? nil : fullName,
                captchaToken: captchaToken
            )
            // If we got no error, Supabase has either signed the user in or
            // sent a confirmation email. Surface a one-liner — the auth-state
            // stream will flip phase once they confirm.
            if authStore.lastError == nil {
                infoMessage = "Check your email to confirm your account."
            } else {
                reportAuthFailure(context: "sign_up")
            }
        }
    }

    /// US-1025: the UI shows friendly copy (``FriendlyErrorCopy``), so the raw
    /// technical detail would otherwise be lost. Capture it to Sentry (and a
    /// PostHog event) so failures stay diagnosable. No-op when no error is set.
    private func reportAuthFailure(context: String) {
        guard let error = authStore.lastError else { return }
        let detail = FriendlyErrorCopy.rawDetail(for: error)
        Telemetry.breadcrumb("Auth \(context) failed: \(detail)", category: "auth")
        Telemetry.event("auth_error", props: ["context": context, "detail": detail])
    }

    private func sendPasswordReset() async {
        let trimmed = email.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else {
            infoMessage = "Enter your email above first, then tap Forgot password."
            return
        }
        let captchaToken: String?
        do {
            captchaToken = try await resolveCaptcha()
        } catch {
            handleCaptchaFailure(error)
            return
        }
        await authStore.resetPassword(email: trimmed, captchaToken: captchaToken)
        if authStore.lastError == nil {
            // Open the web reset page in case the user prefers to handle it
            // there. The deep link in the email also lands here.
            showingPasswordReset = true
            infoMessage = "We sent you a reset link."
        } else {
            reportAuthFailure(context: "reset_password")
        }
    }

    /// Presents the native Turnstile challenge and returns its token. Returns
    /// `nil` when no site key is configured (local/CI builds, where prod-style
    /// captcha enforcement is off too), so the auth call proceeds untokenised.
    /// Throws ``Captcha/Error`` — `.cancelled` when the user backs out.
    private func resolveCaptcha() async throws -> String? {
        guard let siteKey = AppConfig.turnstileSiteKey else { return nil }
        return try await withCheckedThrowingContinuation { continuation in
            captchaRequest = CaptchaRequest(siteKey: siteKey, continuation: continuation)
        }
    }

    /// A cancelled challenge is swallowed silently (matching Apple-cancel);
    /// a real widget failure routes through the visible error region.
    private func handleCaptchaFailure(_ error: Error) {
        if case Captcha.Error.cancelled = error { return }
        authStore.lastError = error
    }

    /// Handles the result of the native Sign in with Apple button. On success,
    /// pulls the identity token + the raw nonce we stashed in `onRequest` and
    /// hands them to Supabase. A user cancel is swallowed silently; anything
    /// else routes through the visible error region.
    private func handleAppleCompletion(_ result: Result<ASAuthorization, Error>) {
        switch result {
        case .success(let authorization):
            guard
                let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                let tokenData = credential.identityToken,
                let idToken = String(data: tokenData, encoding: .utf8),
                let nonce = appleNonce
            else {
                appleNonce = nil
                authStore.lastError = SignInWithAppleError.missingIdentityToken
                return
            }
            let fullName = credential.fullName
            Task {
                await authStore.signInWithApple(idToken: idToken, nonce: nonce, fullName: fullName)
                appleNonce = nil
            }
        case .failure(let error):
            appleNonce = nil
            if let asError = error as? ASAuthorizationError, asError.code == .canceled {
                return
            }
            // ASAuthorizationError.unknown (1000) is a generic wrapper — the
            // actionable cause almost always lives in NSUnderlyingErrorKey
            // (e.g. an AKAuthenticationError from AuthKit). Capture the whole
            // chain to Sentry AND surface it on-screen so a TestFlight tester
            // can read WHY instead of a bare "error 1000".
            let detail = FriendlyErrorCopy.rawDetail(for: error)
            Telemetry.breadcrumb("Sign in with Apple failed: \(detail)", category: "auth")
            Telemetry.event("apple_signin_failed", props: ["detail": detail])
            authStore.lastError = AppleSignInFailure(detail: detail)
        }
    }

    /// Carries the unwrapped underlying reason into the on-screen error region.
    private struct AppleSignInFailure: LocalizedError {
        let detail: String
        var errorDescription: String? { "Sign in with Apple failed.\n\(detail)" }
    }
}

#Preview {
    LoginView()
        .environment(AuthStore())
}
