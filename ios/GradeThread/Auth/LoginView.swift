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
    @State private var infoMessage: String?
    @State private var captchaRequest: CaptchaRequest?
    /// US-1521: the Turnstile widget's own actionable message, shown verbatim
    /// instead of being flattened to the generic "Something went wrong." copy.
    @State private var captchaErrorText: String?

    /// US-1521: focus chain so Return advances the fields (the app's first screen
    /// previously had no keyboard submit wiring at all).
    private enum Field: Hashable { case fullName, email, password }
    @FocusState private var focusedField: Field?

    /// US-810: the address the most recent sign-in was attempted with, captured
    /// at submit time so the "confirm your email" guidance + resend keep naming
    /// the right inbox even if the field is edited afterwards.
    @State private var lastAttemptedEmail = ""
    /// Seconds left on the client-side resend rate-limit (0 = ready). Drives the
    /// disabled state + the "Resend in Ns" label so a user can't hammer GoTrue.
    @State private var resendCooldown = 0
    /// Success line shown under the resend button after a confirmation mail is
    /// re-sent. Cleared on the next sign-in attempt.
    @State private var resendInfo: String?

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
                // US-1521: don't carry a stale error/info across a Sign in↔Sign up
                // switch (a "wrong password" from sign-in lingering over signup).
                .onChange(of: mode) { _, _ in clearAuthMessages() }

                fields

                primaryButton

                // US-1172: the "or" divider implies a choice of social buttons.
                // Google is gated off (AppConfig.googleSignInEnabled), leaving
                // only Apple, so suppress the divider unless there's a second
                // option to separate from email/password.
                if AppConfig.googleSignInEnabled {
                    divider
                }

                socialButtons

                if let infoMessage {
                    Text(infoMessage)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                if let captchaErrorText {
                    // US-1521: the Turnstile widget's own actionable message.
                    Text(captchaErrorText)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                } else if isUnconfirmedSignIn {
                    // US-810: an unconfirmed account gets dedicated guidance +
                    // a resend action instead of the bare error line.
                    unconfirmedEmailCard
                } else if let error = authStore.lastError {
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
                    .focused($focusedField, equals: .fullName)
                    .submitLabel(.next)
                    .onSubmit { focusedField = .email }
            }
            TextField("Email", text: $email)
                .accessibilityIdentifier("login.email") // US-1173: stable UI-test selector
                .focused($focusedField, equals: .email)
                .submitLabel(.next)
                .onSubmit { focusedField = .password }
                .onChange(of: email) { _, _ in clearAuthMessages() }
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
                .accessibilityIdentifier("login.password") // US-1173: stable UI-test selector
                .focused($focusedField, equals: .password)
                .submitLabel(.go)
                .onSubmit { if canSubmit { Task { await submit() } } }
                .onChange(of: password) { _, _ in clearAuthMessages() }
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
        .accessibilityIdentifier("login.submit") // US-1173: stable UI-test selector
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
            .accessibilityIdentifier("login.apple") // US-1173: stable UI-test selector
            // US-1521: don't allow a second exchange (or an email submit) to race
            // an in-flight Apple sign-in.
            .disabled(isSubmitting)
            .opacity(isSubmitting ? 0.5 : 1)
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

    // MARK: - Unconfirmed-email guidance (US-810)

    /// True when the current failure is an unconfirmed-email rejection — the
    /// trigger for the dedicated confirm-your-email card (with resend) instead of
    /// the generic error line. US-1406: no longer gated on `.signIn` mode, so a
    /// user who hits the rejection during the sign-up → auto-sign-in transition
    /// still gets the resend action rather than a bare error with no recovery.
    private var isUnconfirmedSignIn: Bool {
        guard let error = authStore.lastError else { return false }
        return FriendlyErrorCopy.isEmailNotConfirmed(error)
    }

    /// The inbox to name in the guidance: the address the sign-in used, falling
    /// back to whatever is currently typed.
    private var unconfirmedEmail: String {
        let attempted = lastAttemptedEmail.trimmingCharacters(in: .whitespaces)
        return attempted.isEmpty ? email.trimmingCharacters(in: .whitespaces) : attempted
    }

    private var unconfirmedEmailCard: some View {
        VStack(spacing: 10) {
            Text("Confirm your email to sign in")
                .font(.brandHeadline)
                .foregroundStyle(Color.brandNavy)
            Text("We sent a confirmation link to \(unconfirmedEmail). Open it to activate your account, then sign in.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Button {
                Task { await resendConfirmation() }
            } label: {
                Text(resendCooldown > 0 ? "Resend available in \(resendCooldown)s" : "Resend confirmation email")
                    .font(.brandHeadline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Color.brandNavy.opacity(resendCooldown > 0 ? 0.4 : 1))
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
            }
            .disabled(resendCooldown > 0 || isSubmitting)

            if let resendInfo {
                Text(resendInfo)
                    .font(.footnote)
                    .foregroundStyle(.green)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity)
        .background(Color(uiColor: .secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
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
        resendInfo = nil
        captchaErrorText = nil
        let trimmedEmail = email.trimmingCharacters(in: .whitespaces)
        // US-810: remember the address this attempt used so the unconfirmed-email
        // guidance + resend keep naming the right inbox.
        lastAttemptedEmail = trimmedEmail

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
                // US-1521: GoTrue OBFUSCATES a duplicate-email signup as a fake
                // success (no mail is ever sent), so the copy must cover that case
                // rather than promising a confirmation email that won't arrive.
                infoMessage = "If that email is new, check your inbox for a confirmation link. Already have an account? Sign in or reset your password instead."
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
            // US-1205: just confirm — the reset link is in the email. Don't
            // auto-launch a web Safari page the user didn't ask for (the
            // explicit "Reset on the web" affordance remains available).
            infoMessage = "We sent you a reset link. Check your email."
        } else {
            reportAuthFailure(context: "reset_password")
        }
    }

    /// US-810: re-issues the signup confirmation email for an unconfirmed
    /// account. Client-side rate-limited via a 60s cooldown so a user can't
    /// spam GoTrue (which also enforces its own server-side limit). Resolves a
    /// Turnstile token first, mirroring the other auth calls.
    private func resendConfirmation() async {
        let target = unconfirmedEmail
        guard !target.isEmpty, resendCooldown == 0, !isSubmitting else { return }

        let captchaToken: String?
        do {
            captchaToken = try await resolveCaptcha()
        } catch {
            handleCaptchaFailure(error)
            return
        }

        await authStore.resendConfirmation(email: target, captchaToken: captchaToken)
        if authStore.lastError == nil {
            resendInfo = "Confirmation email re-sent to \(target)."
            startResendCooldown()
        } else {
            reportAuthFailure(context: "resend_confirmation")
        }
    }

    /// Starts (or restarts) the 60s resend cooldown countdown. Runs as a
    /// detached child task so the resend action returns immediately; ticking
    /// `resendCooldown` re-renders the button label each second.
    private func startResendCooldown() {
        resendCooldown = 60
        Task {
            while resendCooldown > 0 {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                resendCooldown -= 1
            }
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
        // US-1521: Captcha.Error is a LocalizedError with an ACTIONABLE widget
        // message; show it verbatim instead of routing through authMessage, which
        // flattened every captcha failure to the generic "Something went wrong."
        captchaErrorText = (error as? LocalizedError)?.errorDescription
            ?? error.localizedDescription
    }

    /// US-1521: clear any stale error/info so a message from a prior attempt
    /// doesn't linger over new input (on Sign in↔Sign up toggle or a field edit).
    private func clearAuthMessages() {
        authStore.lastError = nil
        infoMessage = nil
        resendInfo = nil
        captchaErrorText = nil
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
            // US-1250: the Apple user id is no longer recorded here. It's passed
            // into the store and persisted only after the Supabase token exchange
            // succeeds, so a failed exchange can't strand a stale id that a later
            // email/password sign-in would inherit.
            let appleUserId = credential.user
            Task {
                // US-1521: reflect the in-flight exchange — disables the email
                // Sign-in button (via isSubmitting) so it isn't tappable mid-Apple
                // -exchange, and clears any stale captcha error.
                isSubmitting = true
                captchaErrorText = nil
                defer {
                    isSubmitting = false
                    appleNonce = nil
                }
                await authStore.signInWithApple(idToken: idToken, nonce: nonce, appleUserId: appleUserId, fullName: fullName)
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

    /// US-1205: surface friendly copy on-screen (US-1025 convention); the raw
    /// `detail` is kept only for the Sentry breadcrumb/event logged above, not
    /// shown to the user as an opaque "error 1000 / NSUnderlyingError…".
    private struct AppleSignInFailure: LocalizedError {
        let detail: String
        var errorDescription: String? {
            "Sign in with Apple didn't complete. Please try again."
        }
    }
}

#Preview {
    LoginView()
        .environment(AuthStore())
}
