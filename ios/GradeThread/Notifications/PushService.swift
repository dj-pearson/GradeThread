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

    /// Posts the hex token to the edge service. Injectable so tests can
    /// simulate a transient 500 on the first attempt and a success on the
    /// retry without hitting the network (US-1000).
    public typealias RegisterSender =
        @Sendable (_ tokenHex: String, _ environment: String) async throws -> Void

    public static let shared = PushService()

    public private(set) var phase: Phase = .unknown
    /// Hex-encoded most-recent token. Persisted across launches in
    /// UserDefaults so we don't re-register on every cold start when
    /// nothing has changed.
    public private(set) var deviceTokenHex: String?

    private let defaults: UserDefaults
    private let registerSender: RegisterSender

    private let userDefaultsKey = "com.gradethread.app.push.tokenHex"
    /// Hex of the token the edge last *confirmed* it accepted. When this differs
    /// from `deviceTokenHex` (or is absent) the cached token is stale — the
    /// first registration hit a transient failure, or the app was killed before
    /// the POST landed — and must be re-POSTed on the next launch/reconnect.
    private let registeredTokenKey = "com.gradethread.app.push.registeredTokenHex"

    private init() {
        self.defaults = .standard
        self.registerSender = PushService.edgeRegisterSender
        self.deviceTokenHex = defaults.string(forKey: userDefaultsKey)
        self.phase = PushService.initialPhase(
            cachedToken: deviceTokenHex,
            registeredToken: defaults.string(forKey: registeredTokenKey)
        )
    }

    /// Test seam: inject a fake sender + an isolated `UserDefaults` suite so the
    /// retry behavior can be exercised hermetically (US-1000).
    init(defaults: UserDefaults, registerSender: @escaping RegisterSender) {
        self.defaults = defaults
        self.registerSender = registerSender
        self.deviceTokenHex = defaults.string(forKey: userDefaultsKey)
        self.phase = PushService.initialPhase(
            cachedToken: deviceTokenHex,
            registeredToken: defaults.string(forKey: registeredTokenKey)
        )
    }

    /// A cached token counts as `.registered` only when it matches the token the
    /// edge last confirmed; otherwise it's pending a (re)registration so the
    /// launch-time retry picks it up.
    private static func initialPhase(cachedToken: String?, registeredToken: String?) -> Phase {
        guard let cachedToken else { return .unknown }
        return cachedToken == registeredToken
            ? .registered(deviceToken: cachedToken)
            : .registering
    }

    /// Default sender: POST the token to the edge `/register` endpoint.
    private static let edgeRegisterSender: RegisterSender = { tokenHex, environment in
        struct Body: Encodable {
            let device_token: String
            let environment: String
        }
        struct Empty: Decodable {}
        let _: Empty = try await EdgeAPI.shared.postJSON(
            "/api/notifications/register",
            body: Body(device_token: tokenHex, environment: environment)
        )
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
            // US-1000: when the token is unchanged iOS no-ops the call above and
            // `didRegisterForRemoteNotifications` never fires, so a registration
            // that hit a transient 500 would never retry until the OS rotates
            // the token. Re-POST the cached token here if it's still unconfirmed.
            await retryRegistrationIfNeeded()
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
        defaults.set(hex, forKey: userDefaultsKey)
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
        defaults.removeObject(forKey: userDefaultsKey)
        defaults.removeObject(forKey: registeredTokenKey)
        deviceTokenHex = nil
        phase = .unknown
    }

    /// US-1000: re-POST the cached token if a prior registration failed (or was
    /// never confirmed by the edge). Safe to call on every launch/reconnect —
    /// it no-ops once the edge has confirmed the current token, so steady-state
    /// launches don't hit the network. Returns whether a (re)register was sent.
    @discardableResult
    public func retryRegistrationIfNeeded() async -> Bool {
        guard let tokenHex = deviceTokenHex, needsRegistration(tokenHex: tokenHex) else {
            return false
        }
        await registerWithEdge(tokenHex: tokenHex)
        return true
    }

    /// The current token still needs (re)registering unless the edge has already
    /// confirmed this exact token.
    private func needsRegistration(tokenHex: String) -> Bool {
        defaults.string(forKey: registeredTokenKey) != tokenHex
    }

    private func registerWithEdge(tokenHex: String) async {
        phase = .registering
        do {
            try await registerSender(tokenHex, PushService.environmentName)
            // Record the confirmed token so subsequent launches treat it as
            // registered and the retry above short-circuits (idempotent).
            defaults.set(tokenHex, forKey: registeredTokenKey)
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
