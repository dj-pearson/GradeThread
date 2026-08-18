import AVFoundation
import Foundation
import Observation

// US-2504 AC2: the walk-around clip recorder.
//
// One continuous take the server grades frames out of, instead of four staged
// photos. The claim the feature is sold on is that every graded view came from
// ONE take, which is why this records rather than imports, and why choosing
// video is a MODE that clears staged photos rather than an addition to them
// (VideoGradingContract.excludesPhotos).
//
// NO AUDIO, deliberately. A walk-around clip needs none, the frame pipeline
// discards it, and adding an audio input would mean asking for the microphone
// permission and shipping an NSMicrophoneUsageDescription for a feature that
// never listens. Recording a seller's room audio because it was the default is
// the kind of thing that is only noticed from the outside.

@MainActor
@Observable
final class WalkAroundRecorder: NSObject {

    enum Phase: Equatable {
        case idle
        case preparing
        case ready
        case recording(secondsElapsed: Double)
        case finished(Clip)
        case failed(String)
    }

    struct Clip: Equatable {
        let url: URL
        let bytes: Int
        /// nil when AVFoundation could not report it. Passed through as nil
        /// rather than guessed: the server refuses an unreadable duration, and
        /// inventing one here would send a clip that fails after the upload.
        let durationSeconds: Double?
        let format: String

        /// The provenance value the submit posts. Always the recorder's, because
        /// this type is only ever produced by recording.
        var captureSource: String { VideoGradingContract.captureSourceInAppRecorder }
    }

    private(set) var phase: Phase = .idle

    let session = AVCaptureSession()
    private let output = AVCaptureMovieFileOutput()
    private let queue = DispatchQueue(label: "com.gradethread.walkaround.session")
    private var startedAt: Date?
    private var tickTask: Task<Void, Never>?

    /// Where the clip lands. Temporary on purpose: it is uploaded and then it is
    /// rubbish, and a walk-around of somebody's living room is not something to
    /// leave in a container the next backup picks up.
    private var outputURL: URL?

    var elapsedSeconds: Double {
        if case .recording(let seconds) = phase { return seconds }
        return 0
    }

    /// How much of the allowed length is used. Drives the ring; the hard stop is
    /// the output's own maxRecordedDuration, not this.
    var progress: Double {
        min(1, elapsedSeconds / VideoGradingContract.maxDurationSeconds)
    }

    // MARK: - Lifecycle

    func prepare() async {
        guard phase == .idle || isFailed else { return }
        phase = .preparing
        let granted = await Self.requestCameraAccess()
        guard granted else {
            phase = .failed("GradeThread needs camera access to record a walk-around.")
            return
        }
        do {
            try await configure()
            phase = .ready
        } catch {
            phase = .failed("We couldn't start the camera.")
        }
    }

    func startRecording() {
        guard phase == .ready else { return }
        let url = Self.temporaryClipURL()
        outputURL = url
        startedAt = Date()
        phase = .recording(secondsElapsed: 0)
        output.startRecording(to: url, recordingDelegate: self)
        startTicking()
    }

    func stopRecording() {
        guard case .recording = phase else { return }
        output.stopRecording()
    }

    func teardown() {
        tickTask?.cancel()
        tickTask = nil
        queue.async { [session] in
            if session.isRunning { session.stopRunning() }
        }
    }

    /// Deletes the clip file. Called after a successful upload, and on discard.
    /// Failure is ignored on purpose — a leftover file in the temporary
    /// directory is the system's to reap, and surfacing "couldn't delete" to a
    /// seller who just got their grade would be noise.
    func discard(_ clip: Clip) {
        try? FileManager.default.removeItem(at: clip.url)
        if phase == .finished(clip) { phase = .ready }
    }

    // MARK: - Configuration

    private var isFailed: Bool {
        if case .failed = phase { return true }
        return false
    }

    private func configure() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async { [session, output] in
                session.beginConfiguration()
                defer { session.commitConfiguration() }

                // 1080p rather than the highest available. A 4K walk-around
                // blows the 60 MB cap in well under the 45 seconds the same
                // contract allows, so the two limits would contradict each other
                // and the seller would meet the byte one without warning.
                if session.canSetSessionPreset(.hd1920x1080) {
                    session.sessionPreset = .hd1920x1080
                } else {
                    session.sessionPreset = .high
                }

                guard let device = AVCaptureDevice.default(
                    .builtInWideAngleCamera, for: .video, position: .back),
                      let input = try? AVCaptureDeviceInput(device: device),
                      session.canAddInput(input) else {
                    continuation.resume(throwing: RecorderError.noCamera)
                    return
                }
                session.addInput(input)

                guard session.canAddOutput(output) else {
                    continuation.resume(throwing: RecorderError.noOutput)
                    return
                }
                session.addOutput(output)

                // The hard stop belongs to the OUTPUT, not to a timer. A timer
                // that fires late produces a clip the server refuses after the
                // whole upload; AVFoundation stops at the boundary itself.
                output.maxRecordedDuration = CMTime(
                    seconds: VideoGradingContract.maxDurationSeconds,
                    preferredTimescale: 600)
                // And a second backstop on size, for the same reason: the two
                // caps are independent and either can be hit first.
                output.maxRecordedFileSize = Int64(VideoGradingContract.maxBytes)

                continuation.resume()
            }
        }
        queue.async { [session] in
            if !session.isRunning { session.startRunning() }
        }
    }

    private func startTicking() {
        tickTask?.cancel()
        tickTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 100_000_000)
                guard let self, let startedAt = self.startedAt else { return }
                if case .recording = self.phase {
                    self.phase = .recording(secondsElapsed: Date().timeIntervalSince(startedAt))
                } else {
                    return
                }
            }
        }
    }

    private enum RecorderError: Error { case noCamera, noOutput }

    private static func requestCameraAccess() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .video)
        default: return false
        }
    }

    private static func temporaryClipURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("walkaround-\(UUID().uuidString.lowercased()).mov")
    }

    // MARK: - Pure helpers (testable without a camera)

    /// The container name from a file extension, lowercased, for the contract's
    /// format check. Unknown extensions pass through unchanged so the rejection
    /// message names what was actually seen.
    static func format(for url: URL) -> String {
        url.pathExtension.lowercased()
    }

    /// Size in bytes, or 0 when the file is unreadable — which the contract
    /// rejects as "that clip is empty", the right answer either way.
    static func byteSize(of url: URL) -> Int {
        let values = try? url.resourceValues(forKeys: [.fileSizeKey])
        return values?.fileSize ?? 0
    }

    /// Reads the duration, returning nil when AVFoundation cannot.
    ///
    /// nil is passed to the server rather than resolved locally. The server's
    /// refusal of an unreadable duration is a real rule; a client GUESS at one
    /// would either block clips the server would have taken, or claim a length
    /// the frame planner then cannot find.
    static func duration(of url: URL) async -> Double? {
        let asset = AVURLAsset(url: url)
        guard let loaded = try? await asset.load(.duration) else { return nil }
        let seconds = CMTimeGetSeconds(loaded)
        guard seconds.isFinite, seconds > 0 else { return nil }
        return seconds
    }
}

extension WalkAroundRecorder: AVCaptureFileOutputRecordingDelegate {
    nonisolated func fileOutput(
        _ output: AVCaptureFileOutput,
        didFinishRecordingTo outputFileURL: URL,
        from connections: [AVCaptureConnection],
        error: Error?
    ) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.tickTask?.cancel()
            self.tickTask = nil

            // A maxRecordedDuration / maxRecordedFileSize stop reports an ERROR
            // and still writes a usable file. Treating every error as a failure
            // throws away exactly the clip the caps were set to produce.
            let salvageable: Set<Int> = [
                AVError.maximumDurationReached.rawValue,
                AVError.maximumFileSizeReached.rawValue,
            ]
            if let error = error as NSError?,
               error.domain != AVFoundationErrorDomain
                || !salvageable.contains(error.code) {
                try? FileManager.default.removeItem(at: outputFileURL)
                self.phase = .failed("That recording didn't save. Try again.")
                return
            }

            let bytes = Self.byteSize(of: outputFileURL)
            let seconds = await Self.duration(of: outputFileURL)
            self.phase = .finished(Clip(
                url: outputFileURL,
                bytes: bytes,
                durationSeconds: seconds,
                format: Self.format(for: outputFileURL)))
        }
    }
}
