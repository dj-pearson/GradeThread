import CoreLocation
import Foundation

/// A single coarse position, held just long enough to send.
struct RadarFix: Equatable, Sendable {
    let latitude: Double
    let longitude: Double
}

/// US-1861 — the one place the app asks iOS where it is.
///
/// Three deliberate properties:
///
///   • **It is never called unless ``RadarConsent/isContributing`` is true.**
///     Consent before collection means not asking the operating system at all
///     while the answer is no, not asking and discarding.
///   • **It asks for LESS accuracy than iOS would give.** `desiredAccuracy` is
///     `kCLLocationAccuracyKilometer`, because the server only keeps a cell about
///     a kilometre across. Requesting best-available and then throwing precision
///     away would leave the precise fix sitting in memory and in the system's
///     own logs for no reason.
///   • **It always finishes.** Every path resolves within `timeout`, so a scan
///     can await it without a denied/absent/slow fix ever holding up the result
///     the reseller is waiting for.
///
/// Authorization is requested when the user turns the switch ON, not on the
/// first scan — a permission prompt that appears mid-scan reads as a surprise,
/// and the prompt belongs next to the copy that explains why.
@MainActor
final class RadarLocationProvider: NSObject {

    static let shared = RadarLocationProvider()

    private let manager = CLLocationManager()
    private var pending: CheckedContinuation<RadarFix?, Never>?
    private var timeoutTask: Task<Void, Never>?
    private var authPending: CheckedContinuation<Bool, Never>?
    private var authTimeoutTask: Task<Void, Never>?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyKilometer
    }

    var authorizationStatus: CLAuthorizationStatus {
        manager.authorizationStatus
    }

    /// True when a one-shot fix would actually be granted.
    var isAuthorized: Bool {
        switch manager.authorizationStatus {
        case .authorizedWhenInUse, .authorizedAlways:
            return true
        default:
            return false
        }
    }

    /// True once the user has answered the system prompt either way — the
    /// settings row uses it to explain a denial instead of showing a dead
    /// switch.
    var hasBeenAsked: Bool {
        manager.authorizationStatus != .notDetermined
    }

    /// Ask for when-in-use access. No-op once the user has answered; iOS will
    /// not re-prompt, so the settings row points at the Settings app instead.
    func requestAuthorizationIfNeeded() {
        guard manager.authorizationStatus == .notDetermined else { return }
        manager.requestWhenInUseAuthorization()
    }

    /// US-1866: ask, and WAIT for the answer.
    ///
    /// `requestWhenInUseAuthorization()` returns the instant the prompt appears,
    /// so a caller that reads ``isAuthorized`` straight afterwards reads the
    /// answer the user has not given yet — which on the Radar view showed as
    /// "location denied" the first time somebody tapped for it and granted it.
    /// The system prompt has no timeout of its own, so this one always resolves:
    /// a user who walks away leaves the view where it was, not spinning.
    ///
    /// Returns whether a one-shot fix would now be granted. The settings switch
    /// keeps using the fire-and-forget form above — it only needs the prompt to
    /// appear next to the copy that explains it.
    @discardableResult
    func requestAuthorization(timeout: TimeInterval = 60) async -> Bool {
        guard manager.authorizationStatus == .notDetermined else { return isAuthorized }
        // One prompt in flight is enough; a second caller reads the current
        // answer rather than stacking continuations.
        guard authPending == nil else { return isAuthorized }

        return await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            authPending = continuation
            authTimeoutTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(max(0, timeout) * 1_000_000_000))
                guard !Task.isCancelled else { return }
                self?.finishAuth()
            }
            manager.requestWhenInUseAuthorization()
        }
    }

    /// Resume the pending authorization continuation exactly once.
    fileprivate func finishAuth() {
        authTimeoutTask?.cancel()
        authTimeoutTask = nil
        guard let continuation = authPending else { return }
        authPending = nil
        continuation.resume(returning: isAuthorized)
    }

    /// One coarse fix, or nil. Never throws, never hangs past `timeout`, and
    /// never prompts.
    func currentFix(timeout: TimeInterval = 4) async -> RadarFix? {
        guard isAuthorized else { return nil }
        // One request in flight is enough; a second caller gets nil rather than
        // stacking continuations on a single-shot manager.
        guard pending == nil else { return nil }

        return await withCheckedContinuation { (continuation: CheckedContinuation<RadarFix?, Never>) in
            pending = continuation
            timeoutTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(max(0, timeout) * 1_000_000_000))
                guard !Task.isCancelled else { return }
                self?.finish(nil)
            }
            manager.requestLocation()
        }
    }

    /// Resume the pending continuation exactly once.
    fileprivate func finish(_ fix: RadarFix?) {
        timeoutTask?.cancel()
        timeoutTask = nil
        guard let continuation = pending else { return }
        pending = nil
        continuation.resume(returning: fix)
    }
}

// MARK: - CLLocationManagerDelegate

extension RadarLocationProvider: CLLocationManagerDelegate {

    nonisolated func locationManager(
        _ manager: CLLocationManager,
        didUpdateLocations locations: [CLLocation]
    ) {
        // Hop with plain Doubles rather than the CLLocation, so nothing
        // non-Sendable crosses the boundary.
        let latitude = locations.last?.coordinate.latitude
        let longitude = locations.last?.coordinate.longitude
        Task { @MainActor [weak self] in
            guard let latitude, let longitude else {
                self?.finish(nil)
                return
            }
            self?.finish(RadarFix(latitude: latitude, longitude: longitude))
        }
    }

    nonisolated func locationManager(
        _ manager: CLLocationManager,
        didFailWithError error: Error
    ) {
        Task { @MainActor [weak self] in
            self?.finish(nil)
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        // The settings row re-reads the status on its own, and a revocation
        // while a fix is in flight surfaces as didFailWithError. What DOES
        // belong here is the answer to a pending prompt (US-1866) — this
        // callback is the only place iOS reports it. `.notDetermined` still
        // means unanswered, so only a real decision resolves the wait.
        let status = manager.authorizationStatus
        guard status != .notDetermined else { return }
        Task { @MainActor [weak self] in
            self?.finishAuth()
        }
    }
}
