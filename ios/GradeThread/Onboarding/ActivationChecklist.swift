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

    private static let dismissKey = "com.gradethread.app.activationChecklistDismissed"

    var isDismissed: Bool {
        get { UserDefaults.standard.bool(forKey: Self.dismissKey) }
        set { UserDefaults.standard.set(newValue, forKey: Self.dismissKey) }
    }

    func refresh(userId: String?) async {
        if let userId {
            let connection = try? await EbayConnectionService().fetchActiveConnection(userId: userId)
            ebayConnected = (connection != nil)
        }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        notificationsEnabled = settings.authorizationStatus == .authorized
            || settings.authorizationStatus == .provisional
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

            step(
                done: store.ebayConnected,
                title: "Connect eBay",
                subtitle: "Sync your listings, orders, and payouts.",
                systemImage: "antenna.radiowaves.left.and.right"
            ) { router.selection = .marketplaces }

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
        .padding(14)
        .background(Color(uiColor: .secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .task { await store.refresh(userId: userId) }
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
