import SwiftUI
import UserNotifications

/// US-647 — post-signup activation checklist. Surfaces the three steps that get
/// a new user to value (connect eBay, add a first item, enable notifications)
/// with per-step progress, a value-framed notification pre-prompt, and a
/// dismiss. Shown on the Dashboard (and its empty state) until completed or
/// dismissed.
@MainActor
@Observable
final class ActivationChecklistStore {
    var ebayConnected = false
    var notificationsEnabled = false

    /// US-1117: in-flight + error state for the in-app eBay connect flow so the
    /// "Connect eBay" step can be completed without leaving the checklist.
    var ebayConnecting = false
    var ebayConnectError: String?

    private let ebayService: EbayConnectionService

    private static let dismissKey = "com.gradethread.app.activationChecklistDismissed"

    init(ebayService: EbayConnectionService = EbayConnectionService()) {
        self.ebayService = ebayService
    }

    var isDismissed: Bool {
        get { UserDefaults.standard.bool(forKey: Self.dismissKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.dismissKey) }
    }

    /// US-2875: bring the checklist back from Settings, where there is no
    /// instance to reach for. Static because the flag is process-wide, and the
    /// steps themselves are recomputed from real data on the next refresh —
    /// so un-dismissing shows whatever is genuinely still outstanding rather
    /// than resetting anybody's progress.
    static func undismiss() {
        UserDefaults.standard.set(false, forKey: Self.dismissKey)
    }

    func refresh(userId: String?) async {
        if let userId {
            let connection = try? await ebayService.fetchActiveConnection(userId: userId)
            ebayConnected = (connection != nil)
        }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        notificationsEnabled = settings.authorizationStatus == .authorized
            || settings.authorizationStatus == .provisional
    }

    /// US-1117: launches the real in-app eBay OAuth handshake
    /// (`ASWebAuthenticationSession` via ``EbayConnectionService``) so the
    /// activation step completes in-app. On success marks the step done; on
    /// failure surfaces a retry-able error. A user cancel is silent (no error).
    func connectEbay(userId: String) async {
        guard !ebayConnecting, !ebayConnected else { return }
        ebayConnecting = true
        ebayConnectError = nil
        defer { ebayConnecting = false }
        do {
            _ = try await ebayService.connect(userId: userId)
            ebayConnected = true
        } catch let error as EbayConnectionService.ConnectionError {
            switch error {
            case .userCancelled:
                break  // user backed out of the sign-in sheet — not an error
            default:
                ebayConnectError = error.errorDescription
                    ?? "Couldn't connect eBay. Please try again."
            }
        } catch {
            ebayConnectError = "Couldn't connect eBay. Please try again."
        }
    }

    func allComplete(hasItem: Bool) -> Bool {
        hasItem && ebayConnected && notificationsEnabled
    }
}

struct ActivationChecklistView: View {
    let router: AppRouter
    let hasItem: Bool
    @Bindable var store: ActivationChecklistStore

    @Environment(AuthStore.self) private var authStore

    private var userId: String? {
        if case let .signedIn(user) = authStore.phase { return user.id.uuidString }
        return nil
    }

    private var completedCount: Int {
        [hasItem, store.ebayConnected, store.notificationsEnabled].filter { $0 }.count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Get set up")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text("\(completedCount) of 3")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                Button {
                    store.isDismissed = true
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.tertiary)
                }
                .accessibilityLabel("Dismiss setup checklist")
            }

            step(
                done: hasItem,
                title: "Add your first item",
                subtitle: "Snap a few photos and let AI catalog it.",
                systemImage: "camera"
            ) { router.startIntake(.photoFirst) }

            ebayStep

            step(
                done: store.notificationsEnabled,
                title: "Turn on notifications",
                subtitle: "Get notified the moment something sells or a payout lands.",
                systemImage: "bell.badge"
            ) {
                Task {
                    // Value-framed pre-prompt: the row copy above explains the
                    // why before iOS shows the system permission dialog.
                    _ = await PushService.shared.requestPermissionIfNeeded()
                    await store.refresh(userId: userId)
                }
            }
        }
        .padding(16)
        .cardStyle(.flush)
        .task { await store.refresh(userId: userId) }
    }

    // US-1117: "Connect eBay" launches the real in-app OAuth handshake
    // (ASWebAuthenticationSession) instead of just switching tabs, so the
    // activation step can actually be completed without bouncing to the web.
    @ViewBuilder
    private var ebayStep: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                guard !store.ebayConnected, !store.ebayConnecting else { return }
                AppRouter.haptic()
                launchEbayConnect()
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: store.ebayConnected
                        ? "checkmark.circle.fill"
                        : "antenna.radiowaves.left.and.right")
                        .font(.title3)
                        .foregroundStyle(store.ebayConnected ? Color.brandEmerald : Color.brandNavy)
                        .frame(width: 28)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Connect eBay")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.primary)
                            .strikethrough(store.ebayConnected)
                        if !store.ebayConnected {
                            Text("Sign in and sync your listings, orders, and payouts — right here in the app.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 0)
                    if store.ebayConnecting {
                        ProgressView()
                    } else if !store.ebayConnected {
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(store.ebayConnected || store.ebayConnecting)

            if let error = store.ebayConnectError, !store.ebayConnected {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(Color.brandRed)
                    Spacer(minLength: 0)
                    Button("Try again") {
                        AppRouter.haptic()
                        launchEbayConnect()
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.brandNavy)
                    .disabled(store.ebayConnecting)
                }
                .padding(.leading, 40)
            }
        }
    }

    private func launchEbayConnect() {
        guard let userId else {
            // No signed-in user id available (shouldn't happen on the dashboard,
            // but stay safe) — fall back to the Marketplaces tab where the full
            // connection card lives.
            router.selection = .marketplaces
            return
        }
        Task { await store.connectEbay(userId: userId) }
    }

    @ViewBuilder
    private func step(
        done: Bool,
        title: String,
        subtitle: String,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        Button {
            guard !done else { return }
            AppRouter.haptic()
            action()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: done ? "checkmark.circle.fill" : systemImage)
                    .font(.title3)
                    .foregroundStyle(done ? Color.brandEmerald : Color.brandNavy)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .strikethrough(done)
                    if !done {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
                if !done {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(done)
    }
}
