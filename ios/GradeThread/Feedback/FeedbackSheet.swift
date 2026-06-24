import SwiftUI
import UIKit

/// Modal sheet for the 'Send feedback' flow in Settings (US-199). Posts
/// to `/api/notifications/feedback` with the user's message + device
/// metadata; row also lands in `feedback_messages` for support triage.
struct FeedbackSheet: View {
    @Environment(\.dismiss) private var dismiss

    @State private var message: String = ""
    @State private var isSending: Bool = false
    @State private var resultMessage: ResultMessage?
    /// US-1136: escalation to a tracked support ticket (prefilled with whatever
    /// the user has typed so far) when they want a direct reply.
    @State private var showingTicketComposer = false

    private struct ResultMessage: Identifiable {
        let id = UUID()
        let text: String
        let isError: Bool
    }

    private static let maxLength = 2000

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(
                        "What worked, what didn't, what you wish existed…",
                        text: $message,
                        axis: .vertical
                    )
                    .lineLimit(6...12)
                    .disabled(isSending)
                } header: {
                    Text("Your feedback")
                } footer: {
                    Text("Goes straight to the Pearson Media team. We include your account email, app version, OS version, and the last few in-app actions for context.")
                        .font(.footnote)
                }

                if let result = resultMessage {
                    Section {
                        Label(result.text, systemImage: result.isError
                              ? "exclamationmark.triangle"
                              : "checkmark.circle")
                            .foregroundStyle(result.isError ? .brandRed : .brandEmerald)
                            .font(.footnote)
                    }
                }

                Section {
                    Button {
                        Task { await send() }
                    } label: {
                        HStack {
                            if isSending { ProgressView() }
                            Text(isSending ? "Sending…" : "Send feedback")
                                .font(.subheadline.weight(.semibold))
                                .frame(maxWidth: .infinity)
                        }
                        .padding(.vertical, 6)
                    }
                    .disabled(isSending || trimmedMessage.isEmpty)
                }

                // US-1136: escalate quick feedback into a tracked support ticket
                // so the user can get a threaded reply in-app.
                Section {
                    Button {
                        showingTicketComposer = true
                    } label: {
                        Label("Need a reply? Open a support ticket", systemImage: "bubble.left.and.bubble.right")
                            .font(.subheadline)
                    }
                    .disabled(isSending)
                } footer: {
                    Text("Feedback is one-way. Open a support ticket to start a conversation and track our reply.")
                        .font(.footnote)
                }
            }
            .navigationTitle("Send feedback")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }.disabled(isSending)
                }
            }
        }
        .interactiveDismissDisabled(isSending)
        .sheet(isPresented: $showingTicketComposer) {
            SupportTicketsView(initialDraftBody: trimmedMessage)
        }
    }

    // MARK: - Send

    private var trimmedMessage: String {
        message.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func send() async {
        let body = String(trimmedMessage.prefix(Self.maxLength))
        guard !body.isEmpty else { return }
        isSending = true
        defer { isSending = false }

        struct Body: Encodable {
            let message: String
            let source: String
            let app_version: String?
            let os_version: String
            let device_model: String
        }
        struct Empty: Decodable {}
        let payload = Body(
            message: body,
            source: "ios",
            app_version: Self.appVersion,
            os_version: Self.osVersion,
            device_model: Self.deviceModel
        )

        do {
            let _: Empty = try await EdgeAPI.shared.postJSON(
                "/api/notifications/feedback",
                body: payload
            )
            HapticFeedback.success()
            Telemetry.event("feedback_sent")
            resultMessage = ResultMessage(
                text: "Sent — thanks. We read every one.",
                isError: false
            )
            message = ""
            // US-1203: confirm briefly, then auto-dismiss so a user who taps
            // Close immediately doesn't feel like nothing happened.
            A11yAnnounce.announce("Feedback sent")
            try? await Task.sleep(for: .seconds(1.2))
            dismiss()
            return
        } catch let error as EdgeAPIError {
            HapticFeedback.error()
            resultMessage = ResultMessage(
                text: error.errorDescription ?? "Couldn't send. Try again.",
                isError: true
            )
        } catch {
            HapticFeedback.error()
            resultMessage = ResultMessage(
                text: error.localizedDescription,
                isError: true
            )
        }
    }

    // MARK: - Device metadata

    private static var appVersion: String? {
        let dict = Bundle.main.infoDictionary
        let v = dict?["CFBundleShortVersionString"] as? String
        let b = dict?["CFBundleVersion"] as? String
        switch (v, b) {
        case let (v?, b?): return "\(v) (\(b))"
        case let (v?, nil): return v
        case let (nil, b?): return b
        default:           return nil
        }
    }

    private static var osVersion: String {
        let v = UIDevice.current.systemVersion
        return "iOS \(v)"
    }

    private static var deviceModel: String {
        // UIDevice.model is "iPhone" / "iPad" — not granular. The
        // utsname approach gives "iPhone15,3" etc., which support can
        // decode for triage.
        var sys = utsname()
        uname(&sys)
        let mirror = Mirror(reflecting: sys.machine)
        return mirror.children
            .compactMap { $0.value as? Int8 }
            .filter { $0 != 0 }
            .map { String(UnicodeScalar(UInt8($0))) }
            .joined()
    }
}
