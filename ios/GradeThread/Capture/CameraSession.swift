import AVFoundation
import Foundation
import UIKit

/// AVFoundation camera wrapper. Lives on `@MainActor` so the SwiftUI view
/// hosting the preview can drive lifecycle calls directly. The underlying
/// AVCaptureSession configuration runs on a private serial queue to honour
/// Apple's API guidance — they explicitly say not to touch session config
/// from the main thread (it can block UI for a noticeable beat on startup).
@MainActor
public final class CameraSession: NSObject {

    public enum CameraError: LocalizedError {
        case permissionDenied
        case noVideoDevice
        case configurationFailed
        case captureFailed(String)

        public var errorDescription: String? {
            switch self {
            case .permissionDenied:
                return "Camera access is off. Enable it in Settings to capture photos."
            case .noVideoDevice:
                return "No back camera available on this device."
            case .configurationFailed:
                return "Couldn't initialize the camera."
            case .captureFailed(let detail):
                return "Photo capture failed: \(detail)"
            }
        }
    }

    public let session = AVCaptureSession()
    public private(set) var isRunning: Bool = false

    private let sessionQueue = DispatchQueue(label: "com.gradethread.camera-session")
    private let output = AVCapturePhotoOutput()
    private var didConfigure = false
    private var pendingCompletion: ((Result<UIImage, Error>) -> Void)?
    /// Identifies the in-flight capture so a watchdog timeout from an earlier shot
    /// can't resolve a newer one. Cleared in lockstep with `pendingCompletion`.
    private var pendingCaptureID: UUID?
    /// How long to wait for the photo delegate before failing the capture. Without
    /// this, a delegate that never fires (session torn down mid-shot, a silently
    /// dropped capture during an interruption) suspends the awaiting Task forever,
    /// leaving `isCapturing` true and the shutter permanently disabled.
    private static let captureTimeout: Duration = .seconds(12)

    /// US-1408: the caller's INTENT to be running. iOS auto-stops a running
    /// `AVCaptureSession` on a phone call, Control Center / FaceTime PiP, or when
    /// the app backgrounds — and does NOT auto-resume it, leaving a frozen black
    /// preview with a live-but-dead shutter. We track intent so the interruption/
    /// runtime-error observers below can restart the session once the
    /// interruption ends, instead of relying on the view's one-shot `.task`.
    private var shouldBeRunning = false

    public override init() {
        super.init()
        // Observe interruption + runtime-error notifications for THIS session so
        // we can self-heal. Delivered on an arbitrary queue, so the handlers are
        // `nonisolated` and hop back to the main actor (US-1408).
        let center = NotificationCenter.default
        center.addObserver(
            self, selector: #selector(handleWasInterrupted(_:)),
            name: AVCaptureSession.wasInterruptedNotification, object: session)
        center.addObserver(
            self, selector: #selector(handleInterruptionEnded(_:)),
            name: AVCaptureSession.interruptionEndedNotification, object: session)
        center.addObserver(
            self, selector: #selector(handleRuntimeError(_:)),
            name: AVCaptureSession.runtimeErrorNotification, object: session)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - Permission

    public static func authorizationStatus() -> AVAuthorizationStatus {
        AVCaptureDevice.authorizationStatus(for: .video)
    }

    @discardableResult
    public static func requestPermission() async -> Bool {
        await AVCaptureDevice.requestAccess(for: .video)
    }

    // MARK: - Lifecycle

    public func start() async throws {
        let status = Self.authorizationStatus()
        switch status {
        case .authorized:
            break
        case .notDetermined:
            guard await Self.requestPermission() else {
                throw CameraError.permissionDenied
            }
        case .denied, .restricted:
            throw CameraError.permissionDenied
        @unknown default:
            throw CameraError.permissionDenied
        }

        try await configureIfNeeded()
        // session.startRunning() is blocking; push it off-main.
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            sessionQueue.async { [session] in
                if !session.isRunning { session.startRunning() }
                cont.resume()
            }
        }
        shouldBeRunning = true
        isRunning = true
    }

    public func stop() {
        shouldBeRunning = false
        // Tearing the session down cancels any in-flight capture: its delegate
        // will never fire, so resolve the awaiting Task now instead of leaking it.
        finishPendingCapture(.failure(CameraError.captureFailed("Capture cancelled.")))
        let session = self.session
        sessionQueue.async {
            if session.isRunning { session.stopRunning() }
        }
        isRunning = false
    }

    /// US-1408: restart the session after an interruption ends or a runtime
    /// error, but only if the caller still wants it running (didn't `stop()`).
    /// Idempotent — `startRunning()` is a no-op if already running, so this is
    /// safe to call alongside the view's `scenePhase` restart.
    public func restartIfNeeded() {
        guard shouldBeRunning else { return }
        sessionQueue.async { [session] in
            if !session.isRunning { session.startRunning() }
        }
        isRunning = true
    }

    @objc private nonisolated func handleWasInterrupted(_ note: Notification) {
        // US-1408: an interruption (incoming call, Control Center, FaceTime PiP)
        // stops a running session. Reflect that in `isRunning` so the UI never
        // shows a "live" state over a frozen preview; the matching
        // interruptionEnded / scenePhase .active handlers restart it.
        Task { @MainActor in self.isRunning = false }
    }

    @objc private nonisolated func handleInterruptionEnded(_ note: Notification) {
        Task { @MainActor in self.restartIfNeeded() }
    }

    @objc private nonisolated func handleRuntimeError(_ note: Notification) {
        // A runtime error stops the session; AVFoundation recommends restarting
        // it. Only do so if the caller still intends to be running.
        Task { @MainActor in self.restartIfNeeded() }
    }

    // MARK: - Capture

    /// Snaps a photo. Returns the *raw* UIImage — orientation already
    /// baked in by AVFoundation — so the caller can hand it to
    /// ``PhotoCompressor`` for resize + JPEG encode.
    public func capturePhoto() async throws -> UIImage {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<UIImage, Error>) in
            // Guard against overlapping shutter taps.
            guard pendingCompletion == nil else {
                cont.resume(throwing: CameraError.captureFailed("capture in progress"))
                return
            }
            // US-1408 follow-up: never call `capturePhoto` without a live video
            // connection. AVFoundation raises `NSInvalidArgumentException` ("No
            // active and enabled video connection") in that case — an Obj-C
            // exception Swift's `try` CANNOT catch, so the app hard-crashes. This
            // happens when the shutter is tapped during an interruption (incoming
            // call, Control Center, FaceTime PiP) or in the brief window after
            // foregrounding before `startRunning()` has re-activated the session.
            // Fail with a catchable, user-surfaced error instead.
            guard let connection = output.connection(with: .video),
                  connection.isActive, connection.isEnabled else {
                cont.resume(throwing: CameraError.captureFailed(
                    "Camera isn't ready yet — try again in a moment."))
                return
            }

            let captureID = UUID()
            pendingCaptureID = captureID
            pendingCompletion = { result in
                switch result {
                case .success(let image): cont.resume(returning: image)
                case .failure(let error): cont.resume(throwing: error)
                }
            }

            // Watchdog: if the delegate hasn't delivered within the timeout, fail
            // this capture (and only this one — guarded by `captureID`) so the
            // awaiting Task can't hang and strand the shutter.
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: Self.captureTimeout)
                guard let self, self.pendingCaptureID == captureID else { return }
                self.finishPendingCapture(
                    .failure(CameraError.captureFailed("Camera timed out — please try again.")))
            }

            let settings = AVCapturePhotoSettings(format: [
                AVVideoCodecKey: AVVideoCodecType.jpeg
            ])
            // Auto-correct red-eye on devices that support it; quiet flash
            // policy so the camera doesn't surprise the user in a quiet
            // shop. We never request flash explicitly — outdoor / indoor
            // sourcing is fine on a modern back camera.
            settings.flashMode = .off
            // Opt this shot in to the highest quality the output allows.
            // `maxPhotoQualityPrioritization` (set to `.quality` at config
            // time) only raises the *ceiling*; each settings object still
            // defaults to `.balanced`, so without this the full-quality
            // pipeline is never actually exercised. We clamp to the output's
            // configured ceiling so we never request a level it can't honour
            // (rawValue compare — the Obj-C enum isn't `Comparable`).
            settings.photoQualityPrioritization =
                output.maxPhotoQualityPrioritization.rawValue
                    >= AVCapturePhotoOutput.QualityPrioritization.quality.rawValue
                ? .quality
                : output.maxPhotoQualityPrioritization

            output.capturePhoto(with: settings, delegate: self)
        }
    }

    // MARK: - Configuration

    private func configureIfNeeded() async throws {
        guard !didConfigure else { return }

        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            sessionQueue.async { [session, output] in
                session.beginConfiguration()
                session.sessionPreset = .photo

                // US-2137 AC2: prefer macro-capable hardware. The discovery
                // session returns devices in ITS order, so the choice is made by
                // MacroCameraSelection rather than by taking the first one back
                // - taking the first is how a wide-angle gets picked on a phone
                // that has a triple, which downgrades every macro shot silently.
                //
                // Falls back to AVCaptureDevice.default(.builtInWideAngleCamera)
                // when discovery finds nothing recognised, which is EXACTLY the
                // previous behaviour on older hardware.
                let discovered = AVCaptureDevice.DiscoverySession(
                    deviceTypes: MacroCameraSelection.preferredTypes,
                    mediaType: .video,
                    position: .back
                ).devices
                let chosen: AVCaptureDevice? = MacroCameraSelection
                    .indexOfPreferred(among: discovered.map(\.deviceType))
                    .map { discovered[$0] }
                    ?? AVCaptureDevice.default(
                        .builtInWideAngleCamera,
                        for: .video,
                        position: .back
                    )

                guard let device = chosen else {
                    session.commitConfiguration()
                    cont.resume(throwing: CameraError.noVideoDevice)
                    return
                }

                do {
                    let input = try AVCaptureDeviceInput(device: device)
                    guard session.canAddInput(input) else {
                        session.commitConfiguration()
                        cont.resume(throwing: CameraError.configurationFailed)
                        return
                    }
                    session.addInput(input)
                } catch {
                    session.commitConfiguration()
                    cont.resume(throwing: error)
                    return
                }

                guard session.canAddOutput(output) else {
                    session.commitConfiguration()
                    cont.resume(throwing: CameraError.configurationFailed)
                    return
                }
                session.addOutput(output)
                output.maxPhotoQualityPrioritization = .quality

                session.commitConfiguration()
                cont.resume()
            }
        }
        didConfigure = true
    }
}

// MARK: - AVCapturePhotoCaptureDelegate

extension CameraSession: AVCapturePhotoCaptureDelegate {
    public nonisolated func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: Error?
    ) {
        // Bounce back to the main actor so we can touch
        // `pendingCompletion` without isolation warnings.
        Task { @MainActor in
            self.deliver(photo: photo, error: error)
        }
    }

    private func deliver(photo: AVCapturePhoto, error: Error?) {
        if let error {
            finishPendingCapture(.failure(error))
            return
        }
        guard
            let data = photo.fileDataRepresentation(),
            let image = UIImage(data: data)
        else {
            finishPendingCapture(.failure(CameraError.captureFailed("no image data")))
            return
        }
        finishPendingCapture(.success(image))
    }

    /// Resolve the in-flight capture exactly once. Every resolution path — the
    /// photo delegate, the watchdog timeout, and `stop()` — routes through here,
    /// so the underlying continuation is resumed once and only once (a second
    /// call is a no-op because `pendingCompletion` is already nil).
    private func finishPendingCapture(_ result: Result<UIImage, Error>) {
        guard let completion = pendingCompletion else { return }
        pendingCompletion = nil
        pendingCaptureID = nil
        completion(result)
    }
}
