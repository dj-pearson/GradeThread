import Foundation
import UIKit
import UserNotifications

/// Owns the APNs lifecycle: permission prompt, registerForRemoteNotifications,
/// hex-encoded token capture, and `POST /api/notifications/register` to
/// hand the token off to the edge service so the server can target this
/// device.
@MainActor
public final class PushService {

    public enum Phase: Equatable {
        case unknown
        case awaitingPermission
        case denied
        case authorized
        case registering
        case registered(deviceToken: String)
        case registrationFailed(message: String)
    }

    public static let shared = PushService()

    public private(set) var phase: Phase = .unknown
    /// Hex-encoded most-recent token. Persisted across launches in
    /// UserDefaults so we don't re-register on every cold start when
    /// nothing has changed.
    public private(set) var deviceTokenHex: String?

    private let userDefaultsKey = "com.gradethread.app.push.tokenHex"

    private init() {
        self.deviceTokenHex = UserDefaults.standard.string(forKey: userDefaultsKey)
        if deviceTokenHex != nil {
            self.phase = .registered(deviceToken: deviceTokenHex!)
        }
    }

    // MARK: - Permission

    /// Surfaces the iOS prompt the first time it's called, returns the
    /// current status on subsequent calls. Per the AC, callers invoke
    /// this on first Sales tab appearance — not at app launch.
    @discardableResult
    public func requestPermissionIfNeeded() async -> UNAuthorizationStatus {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .notDetermined:
            phase = .awaitingPermission
            let granted = (try? await center.requestAuthorization(
                options: [.alert, .badge, .sound]
            )) ?? false
            phase = granted ? .authorized : .denied
            if granted {
                await registerForRemoteNotifications()
            }
            return granted ? .authorized : .denied
        case .authorized, .provisional, .ephemeral:
            phase = .authorized
            // Re-register on every launch — APNs may have rotated the
            // token while we were asleep. iOS no-ops if nothing changed.
            await registerForRemoteNotifications()
            return settings.authorizationStatus
        case .denied:
            phase = .denied
            return .denied
        @unknown default:
            return settings.authorizationStatus
        }
    }

    private func registerForRemoteNotifications() async {
        UIApplication.shared.registerForRemoteNotifications()
    }

    // MARK: - Token handling

    /// Called from AppDelegate's didRegisterForRemoteNotifications.
    public func handleDeviceToken(_ token: Data) {
        let hex = token.map { String(format: "%02x", $0) }.joined()
        deviceTokenHex = hex
        UserDefaults.standard.set(hex, forKey: userDefaultsKey)
        phase = .registering
        Task { await registerWithEdge(tokenHex: hex) }
    }

    /// Called from AppDelegate's didFailToRegisterForRemoteNotifications.
    public func handleRegistrationError(_ error: Error) {
        phase = .registrationFailed(message: error.localizedDescription)
    }

    /// US-659: clear the persisted APNs token on sign-out so the next user on
    /// this device doesn't inherit the previous user's push registration.
    public func clearTokenOnSignOut() {
        UserDefaults.standard.removeObject(forKey: userDefaultsKey)
        deviceTokenHex = nil
        phase = .unknown
    }

    private func registerWithEdge(tokenHex: String) async {
        struct Body: Encodable {
            let device_token: String
            let environment: String
        }
        struct Empty: Decodable {}
        do {
            let _: Empty = try await EdgeAPI.shared.postJSON(
                "/api/notifications/register",
                body: Body(
                    device_token: tokenHex,
                    environment: PushService.environmentName
                )
            )
            phase = .registered(deviceToken: tokenHex)
        } catch let error as EdgeAPIError {
            phase = .registrationFailed(message: error.errorDescription ?? "Registration failed.")
        } catch {
            phase = .registrationFailed(message: error.localizedDescription)
        }
    }

    /// Mirrors the aps-environment entitlement value. The release
    /// workflow flips both this and the entitlement to "production" for
    /// TestFlight builds.
    static var environmentName: String {
        #if DEBUG
        return "development"
        #else
        return "production"
        #endif
    }
}
