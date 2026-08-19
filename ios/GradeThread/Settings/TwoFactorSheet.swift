import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit

/// US-2671 — the Settings surface for TOTP two-factor authentication.
///
/// Three states, and the middle one is the reason this screen exists at all: a
/// member whose workspace requires 2FA signs in at `aal1` every time, so
/// "enrolled" is not the same as "allowed to work right now". The enrolled-but-
/// not-elevated state offers a code box rather than only a green badge.
///
/// Recovery codes are minted on the web card, not here — see ``TwoFactorStore``
/// for why — and the footer says so instead of leaving the user to discover it.
struct TwoFactorSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var store = TwoFactorStore()
    @State private var code = ""
    @State private var confirmingDisable = false
    @State private var didCopySecret = false

    var body: some View {
        NavigationStack {
            Form {
                switch store.phase {
                case .loading:
                    Section {
                        HStack {
                            Spacer()
                            ProgressView()
                            Spacer()
                        }
                        .padding(.vertical, 12)
                    }
                case .disabled:
                    notEnrolledSections
                case let .enrolling(enrollment):
                    enrollingSections(enrollment)
                case let .enabled(_, aal2):
                    enabledSections(aal2: aal2)
                case let .failed(message):
                    Section {
                        Label(message, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .accessibilityLabel(message)
                        Button("Try again") { Task { await store.refresh() } }
                            .accessibilityLabel("Try again")
                    }
                }
            }
            .navigationTitle("Two-factor authentication")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                        .disabled(store.busy)
                        .accessibilityLabel("Done")
                }
            }
        }
        .task { await store.refresh() }
        .interactiveDismissDisabled(store.busy)
    }

    // MARK: - Not enrolled

    @ViewBuilder
    private var notEnrolledSections: some View {
        Section {
            Label("Two-factor authentication is off.", systemImage: "shield.slash")
                .font(.subheadline)
                .accessibilityLabel("Two-factor authentication is off")
        } footer: {
            Text("Add a one-time code from an authenticator app (Google Authenticator, 1Password, Authy) as a second factor when you sign in. If your workspace owner requires it, you need this to keep working in their workspace.")
                .font(.footnote)
        }

        errorSection

        Section {
            Button {
                Task { await store.startEnrollment() }
            } label: {
                HStack {
                    if store.busy { ProgressView() }
                    Text(store.busy ? "Setting up…" : "Set up two-factor authentication")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                }
                .padding(.vertical, 6)
            }
            .disabled(store.busy)
            .accessibilityLabel("Set up two-factor authentication")
        }
    }

    // MARK: - Enrolling

    @ViewBuilder
    private func enrollingSections(_ enrollment: TwoFactorStore.Enrollment) -> some View {
        Section {
            if let qr = Self.qrImage(from: enrollment.uri) {
                HStack {
                    Spacer()
                    Image(uiImage: qr)
                        .interpolation(.none)
                        .resizable()
                        .frame(width: 200, height: 200)
                        .accessibilityLabel("QR code for your authenticator app")
                    Spacer()
                }
                .padding(.vertical, 8)
            }
        } header: {
            Text("Step 1: scan this")
        } footer: {
            Text("Open your authenticator app and scan the code. Can't scan? Enter the key below by hand.")
                .font(.footnote)
        }

        Section {
            LabeledContent("Setup key") {
                Text(Self.groupedSecret(enrollment.secret))
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
            }
            Button {
                // 120s pasteboard expiry (US-696 convention): the shared secret
                // is a credential, and a general pasteboard is readable by every
                // app and syncs to the Mac via Universal Clipboard.
                SecurePasteboard.copy(enrollment.secret)
                didCopySecret = true
            } label: {
                Label(didCopySecret ? "Copied" : "Copy setup key", systemImage: "doc.on.doc")
            }
            .accessibilityLabel("Copy setup key")
        }

        Section {
            codeField(prompt: "Enter the 6-digit code")
        } header: {
            Text("Step 2: confirm")
        } footer: {
            Text("Codes change every 30 seconds. Enter the one showing now.")
                .font(.footnote)
        }

        errorSection

        Section {
            Button {
                Task {
                    await store.confirmEnrollment(code: code)
                    code = ""
                }
            } label: {
                HStack {
                    if store.busy { ProgressView() }
                    Text(store.busy ? "Verifying…" : "Verify and turn on")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                }
                .padding(.vertical, 6)
            }
            .disabled(store.busy || !TwoFactorCode.isComplete(code))
            .accessibilityLabel("Verify and turn on")

            Button(role: .cancel) {
                Task {
                    code = ""
                    await store.cancelEnrollment()
                }
            } label: {
                Text("Cancel setup")
                    .frame(maxWidth: .infinity)
            }
            .disabled(store.busy)
            .accessibilityLabel("Cancel setup")
        }
    }

    // MARK: - Enabled

    @ViewBuilder
    private func enabledSections(aal2: Bool) -> some View {
        Section {
            Label("Two-factor authentication is on.", systemImage: "checkmark.shield.fill")
                .foregroundStyle(Color.brandEmerald)
                .font(.subheadline.weight(.semibold))
                .accessibilityLabel("Two-factor authentication is on")
        } footer: {
            Text("You'll be asked for a code from your authenticator app. Recovery codes are managed on gradethread.com. Keep them somewhere other than this phone.")
                .font(.footnote)
        }

        if !aal2 {
            // The state the story is actually about. A verified factor and an
            // aal1 session is exactly what a workspace-blocked member has after
            // every cold sign-in, and the edge denies every request until a code
            // elevates the session.
            Section {
                codeField(prompt: "Enter the 6-digit code")
                Button {
                    Task {
                        await store.elevate(code: code)
                        code = ""
                    }
                } label: {
                    HStack {
                        if store.busy { ProgressView() }
                        Text(store.busy ? "Confirming…" : "Confirm it's you")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                    }
                    .padding(.vertical, 6)
                }
                .disabled(store.busy || !TwoFactorCode.isComplete(code))
                .accessibilityLabel("Confirm it's you")
            } header: {
                Text("Confirm this session")
            } footer: {
                Text("Signing in with your password alone doesn't satisfy a workspace that requires two-factor authentication. Enter a code once per sign-in to unlock it, and to change this setting.")
                    .font(.footnote)
            }
        }

        errorSection

        Section {
            Button(role: .destructive) {
                confirmingDisable = true
            } label: {
                Label("Turn off two-factor authentication", systemImage: "shield.slash")
            }
            .disabled(store.busy || !aal2)
            .accessibilityLabel("Turn off two-factor authentication")
            .confirmationDialog(
                "Turn off two-factor authentication?",
                isPresented: $confirmingDisable,
                titleVisibility: .visible
            ) {
                Button("Turn off", role: .destructive) {
                    Task { await store.disable() }
                }
                Button("Keep it on", role: .cancel) {}
            } message: {
                Text("Your account goes back to a password only. If your workspace owner requires two-factor authentication, you'll be locked out of their workspace.")
            }
        } footer: {
            if !aal2 {
                Text("Confirm this session with a code before you can turn it off.")
                    .font(.footnote)
            }
        }
    }

    // MARK: - Shared pieces

    @ViewBuilder
    private var errorSection: some View {
        if let message = store.errorMessage {
            Section {
                Label(message, systemImage: "xmark.octagon")
                    .foregroundStyle(.red)
                    .font(.footnote)
                    .accessibilityLabel(message)
            }
        }
    }

    private func codeField(prompt: String) -> some View {
        TextField(prompt, text: $code)
            .keyboardType(.numberPad)
            .textContentType(.oneTimeCode)
            .font(.system(.title3, design: .monospaced))
            .disabled(store.busy)
            .accessibilityLabel("Six digit code")
            .onChange(of: code) { _, newValue in
                // Normalise in the binding, not on submit: authenticator apps
                // render "123 456" and a paste carries the space, which would
                // otherwise fail a length check the user cannot see.
                let cleaned = TwoFactorCode.normalized(newValue)
                if cleaned != newValue { code = cleaned }
            }
    }

    // MARK: - QR

    /// Renders the `otpauth://` URI locally with CoreImage rather than using the
    /// `qrCode` field GoTrue returns, which is an SVG document — SwiftUI has no
    /// SVG renderer, so displaying it would have meant a WebView for a 200pt
    /// square. The URI and the SVG encode the same string.
    static func qrImage(from uri: String) -> UIImage? {
        guard let payload = uri.data(using: .utf8) else { return nil }
        let filter = CIFilter.qrCodeGenerator()
        filter.message = payload
        // M: recovers ~15% damage. L would be smaller; a screen QR is not
        // damaged, but it is photographed off a second phone at an angle.
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        // The generator emits roughly one pixel per module. Scale before
        // rasterising so the bitmap is crisp instead of an interpolated blur.
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
        let context = CIContext()
        guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else {
            return nil
        }
        return UIImage(cgImage: cgImage)
    }

    /// Base32 secrets are read off a screen and typed into another device.
    /// Four-character groups are what every authenticator app shows.
    static func groupedSecret(_ secret: String) -> String {
        stride(from: 0, to: secret.count, by: 4).map { offset in
            let start = secret.index(secret.startIndex, offsetBy: offset)
            let end = secret.index(start, offsetBy: min(4, secret.count - offset))
            return String(secret[start..<end])
        }.joined(separator: " ")
    }
}
