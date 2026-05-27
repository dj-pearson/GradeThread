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
        isRunning = true
    }

    public func stop() {
        let session = self.session
        sessionQueue.async {
            if session.isRunning { session.stopRunning() }
        }
        isRunning = false
        detectionContinuation?.finish()
        detectionContinuation = nil
    }

    /// Stream of recognised barcode strings. Each `for await` iteration
    /// receives one detected code; iterate at most once for the
    /// single-shot scan-and-dismiss flow the AC describes.
    public func detections() -> AsyncStream<String> {
        AsyncStream { continuation in
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
        if code == lastEmittedCode, Date().timeIntervalSince(lastEmittedAt) < Self.dedupeWindow {
            return
        }
        lastEmittedCode = code
        lastEmittedAt = .now
        detectionContinuation?.yield(code)
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

        let request = VNDetectBarcodesRequest { [weak self] request, _ in
            guard let observations = request.results as? [VNBarcodeObservation] else { return }
            for obs in observations {
                guard let payload = obs.payloadStringValue, !payload.isEmpty else { continue }
                self?.handleDetected(code: payload)
                break
            }
        }
        request.symbologies = BarcodeScanner.symbologies

        let handler = VNImageRequestHandler(
            cvPixelBuffer: pixelBuffer,
            orientation: .right,  // back camera natively rotated
            options: [:]
        )
        try? handler.perform([request])
    }
}
