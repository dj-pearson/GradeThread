import AVFoundation
import Foundation
import Vision

/// AVCaptureSession + Vision pipeline that emits recognized barcode
/// strings via an `AsyncStream<String>`. Per US-179 AC, uses
/// `VNDetectBarcodesRequest` rather than the simpler
/// `AVCaptureMetadataOutput` path — slightly more code, but reuses the
/// same Vision plumbing as the OCR fallback (US-177) and gives finer
/// control over symbology selection.
@MainActor
public final class BarcodeScanner: NSObject {

    public enum BarcodeError: LocalizedError {
        case permissionDenied
        case noVideoDevice
        case configurationFailed

        public var errorDescription: String? {
            switch self {
            case .permissionDenied:
                return "Camera access is off. Enable it in Settings to scan barcodes."
            case .noVideoDevice:
                return "No back camera available on this device."
            case .configurationFailed:
                return "Couldn't start the scanner."
            }
        }
    }

    /// Symbologies the scanner reacts to. Covers retail (EAN/UPC), thrift
    /// SKU stickers (Code 128 is the de-facto retail-arbitrage format),
    /// and QR codes (occasionally used by sellers for batch tags).
    public static let symbologies: [VNBarcodeSymbology] = [
        .ean13, .ean8, .upce, .code128, .qr,
    ]

    public let session = AVCaptureSession()
    public private(set) var isRunning: Bool = false

    /// US-1408: caller's intent to be running, so an interrupted session (call /
    /// Control Center / app background — iOS stops it and never auto-resumes) can
    /// be restarted instead of leaving a frozen scanner preview.
    private var shouldBeRunning = false

    private let sessionQueue = DispatchQueue(label: "com.gradethread.barcode-scanner")
    private let videoOutput = AVCaptureVideoDataOutput()
    private let videoQueue = DispatchQueue(label: "com.gradethread.barcode-video")
    private var didConfigure = false
    private var detectionContinuation: AsyncStream<String>.Continuation?

    /// Backstop against duplicate emits — Vision can recognize the same
    /// code on consecutive frames. We hold the most recent emit and
    /// suppress repeats within a short window so the consumer's
    /// single-shot dismiss flow doesn't fire twice.
    private var lastEmittedCode: String?
    private var lastEmittedAt: Date = .distantPast
    private static let dedupeWindow: TimeInterval = 1.0

    /// Single-shot gate. Once the first code is delivered we suppress every
    /// later emit and finish the stream, so two simultaneously-visible
    /// barcodes can't race to deliver different codes after the consumer has
    /// already accepted one. Reset when a fresh `detections()` stream opens.
    private var hasEmitted = false

    /// One reusable Vision request, lazily built and reused across every
    /// sample buffer instead of allocating a fresh request per frame.
    /// Only ever touched on the serial `videoQueue`, so `nonisolated(unsafe)`
    /// is race-free here.
    nonisolated(unsafe) private var barcodeRequest: VNDetectBarcodesRequest?

    public override init() {
        super.init()
        // US-1408: self-heal from interruptions / runtime errors on this session.
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
        case .authorized: break
        case .notDetermined:
            guard await Self.requestPermission() else { throw BarcodeError.permissionDenied }
        case .denied, .restricted:
            throw BarcodeError.permissionDenied
        @unknown default:
            throw BarcodeError.permissionDenied
        }

        try await configureIfNeeded()

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
        let session = self.session
        sessionQueue.async {
            if session.isRunning { session.stopRunning() }
        }
        isRunning = false
        detectionContinuation?.finish()
        detectionContinuation = nil
    }

    /// US-1408: restart after an interruption ends / runtime error, only if the
    /// caller still wants the scanner running. Idempotent.
    public func restartIfNeeded() {
        guard shouldBeRunning else { return }
        sessionQueue.async { [session] in
            if !session.isRunning { session.startRunning() }
        }
        isRunning = true
    }

    @objc private nonisolated func handleWasInterrupted(_ note: Notification) {
        // Mirror CameraSession: an interruption (call, Control Center, PiP) stops
        // the session, so reflect that in `isRunning` instead of reporting "live"
        // over a frozen preview; interruptionEnded restarts it.
        Task { @MainActor in self.isRunning = false }
    }

    @objc private nonisolated func handleInterruptionEnded(_ note: Notification) {
        Task { @MainActor in self.restartIfNeeded() }
    }

    @objc private nonisolated func handleRuntimeError(_ note: Notification) {
        Task { @MainActor in self.restartIfNeeded() }
    }

    /// Stream of recognised barcode strings. Each `for await` iteration
    /// receives one detected code; iterate at most once for the
    /// single-shot scan-and-dismiss flow the AC describes.
    public func detections() -> AsyncStream<String> {
        // A fresh consumer begins a new single-shot scan, so re-open the gate
        // and clear the dedupe memory from any prior scan.
        hasEmitted = false
        lastEmittedCode = nil
        lastEmittedAt = .distantPast
        return AsyncStream { continuation in
            detectionContinuation = continuation
            continuation.onTermination = { [weak self] _ in
                Task { @MainActor in
                    self?.detectionContinuation = nil
                }
            }
        }
    }

    // MARK: - Configuration

    private func configureIfNeeded() async throws {
        guard !didConfigure else { return }

        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            sessionQueue.async { [session, videoOutput, videoQueue] in
                session.beginConfiguration()
                session.sessionPreset = .high

                guard let device = AVCaptureDevice.default(
                    .builtInWideAngleCamera,
                    for: .video,
                    position: .back
                ) else {
                    session.commitConfiguration()
                    cont.resume(throwing: BarcodeError.noVideoDevice)
                    return
                }

                do {
                    let input = try AVCaptureDeviceInput(device: device)
                    guard session.canAddInput(input) else {
                        session.commitConfiguration()
                        cont.resume(throwing: BarcodeError.configurationFailed)
                        return
                    }
                    session.addInput(input)
                } catch {
                    session.commitConfiguration()
                    cont.resume(throwing: error)
                    return
                }

                videoOutput.setSampleBufferDelegate(self, queue: videoQueue)
                videoOutput.alwaysDiscardsLateVideoFrames = true
                guard session.canAddOutput(videoOutput) else {
                    session.commitConfiguration()
                    cont.resume(throwing: BarcodeError.configurationFailed)
                    return
                }
                session.addOutput(videoOutput)
                session.commitConfiguration()
                cont.resume()
            }
        }
        didConfigure = true
    }

    // MARK: - Emission

    nonisolated fileprivate func handleDetected(code: String) {
        // The delegate callback runs on `videoQueue`. Bounce to main so
        // the dedupe state + continuation aren't accessed across actors.
        Task { @MainActor in
            self.deliver(code: code)
        }
    }

    private func deliver(code: String) {
        // Single-shot: the first code wins. Runs on the main actor, so this
        // gate is serialized — a second frame carrying a different barcode
        // can't slip an emit through after the first.
        guard !hasEmitted else { return }
        if code == lastEmittedCode, Date().timeIntervalSince(lastEmittedAt) < Self.dedupeWindow {
            return
        }
        hasEmitted = true
        lastEmittedCode = code
        lastEmittedAt = .now
        detectionContinuation?.yield(code)
        // Close the stream so the consumer's `for await` ends after exactly
        // one code and no further frames are emitted.
        detectionContinuation?.finish()
        detectionContinuation = nil
    }
}

// MARK: - Video data delegate

extension BarcodeScanner: AVCaptureVideoDataOutputSampleBufferDelegate {
    public nonisolated func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        // Build the Vision request once and reuse it across frames — Vision
        // re-runs the same request object per `perform`, so there's no need to
        // allocate (and configure symbologies on) a new one every sample
        // buffer. Safe to lazily init here: this delegate only ever fires on
        // the serial `videoQueue`.
        let request = reusableBarcodeRequest()

        let handler = VNImageRequestHandler(
            cvPixelBuffer: pixelBuffer,
            orientation: .right,  // back camera natively rotated
            options: [:]
        )
        try? handler.perform([request])
    }

    /// Lazily builds (once) and returns the shared barcode request. Only
    /// called from `captureOutput`, which runs serially on `videoQueue`, so
    /// the check-then-store is race-free.
    nonisolated private func reusableBarcodeRequest() -> VNDetectBarcodesRequest {
        if let existing = barcodeRequest { return existing }
        let request = VNDetectBarcodesRequest { [weak self] request, _ in
            guard let observations = request.results as? [VNBarcodeObservation] else { return }
            for obs in observations {
                guard let payload = obs.payloadStringValue, !payload.isEmpty else { continue }
                self?.handleDetected(code: payload)
                break
            }
        }
        request.symbologies = BarcodeScanner.symbologies
        barcodeRequest = request
        return request
    }
}
