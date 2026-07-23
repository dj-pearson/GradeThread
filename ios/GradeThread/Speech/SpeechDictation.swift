import AVFoundation
import Foundation
import Observation
import Speech

/// Live speech-to-text for the manual intake form's Notes field.
/// Wraps `SFSpeechRecognizer` driven from `AVAudioEngine`. Partial results
/// stream into ``recognizedText`` as the user speaks; the caller pipes
/// that into the bound TextField each render.
///
/// Two distinct permissions: speech recognition (per
/// `NSSpeechRecognitionUsageDescription`) AND microphone access (per
/// `NSMicrophoneUsageDescription`). Both are required and asked once.
@MainActor
@Observable
public final class SpeechDictation {
    public enum DictationError: LocalizedError {
        case speechPermissionDenied
        case microphonePermissionDenied
        case recognizerUnavailable
        case engineFailure(String)

        public var errorDescription: String? {
            switch self {
            case .speechPermissionDenied:
                return "Speech recognition is off in Settings. Turn it on to dictate notes."
            case .microphonePermissionDenied:
                return "Microphone access is off. Turn it on to dictate notes."
            case .recognizerUnavailable:
                return "Speech recognition isn't available on this device right now."
            case .engineFailure(let detail):
                return "Audio engine failed: \(detail)"
            }
        }
    }

    public private(set) var isRecording: Bool = false
    /// Current recognized text. Starts blank when ``start()`` is called and
    /// grows as partial results arrive. The owning view writes it into
    /// the bound model on each change.
    public private(set) var recognizedText: String = ""
    /// The FINAL transcription, published separately from ``recognizedText``
    /// (US-1230). When recognition finalizes the task callback sets this and
    /// then immediately calls ``stop()`` in the same main-actor turn, flipping
    /// `isRecording` to false. A view that mirrors `recognizedText` into its
    /// model behind an `isRecording` guard would therefore DROP this last
    /// segment; observing `finalizedText` lets it apply the finalized value
    /// regardless. Reset to nil on the next ``start()`` / ``reset()``.
    public private(set) var finalizedText: String?
    public var lastError: Error?

    /// True when the device + locale combo can run a recognizer at all.
    /// The simulator can return false here on some Xcode/SDK combos, so
    /// the UI should hide the mic button when this is false.
    public var isAvailable: Bool {
        recognizer?.isAvailable ?? false
    }

    private let recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private let audioEngine = AVAudioEngine()
    /// True once ``beginSession()`` has installed the input-node tap, so
    /// ``stop()`` removes it exactly once (a redundant removeTap on a restart
    /// or a doubled error+final callback otherwise tears down a tap we never
    /// re-installed). US-1230.
    private var didInstallTap = false
    /// True once ``beginSession()`` has activated the shared audio session, so
    /// ``stop()`` only deactivates the session THIS instance activated — never
    /// another app's (or our own already-released) session. US-1230.
    private var didActivateSession = false

    public init(locale: Locale = .current) {
        self.recognizer = SFSpeechRecognizer(locale: locale)
            ?? SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    }

    // MARK: - Permission

    public static func authorizationStatus() -> SFSpeechRecognizerAuthorizationStatus {
        SFSpeechRecognizer.authorizationStatus()
    }

    @discardableResult
    public func requestPermissions() async -> Bool {
        let speech: SFSpeechRecognizerAuthorizationStatus = await withCheckedContinuation { cont in
            SFSpeechRecognizer.requestAuthorization { status in
                cont.resume(returning: status)
            }
        }
        guard speech == .authorized else { return false }

        // iOS 17 microphone permission API. We bumped the deployment
        // target to 17 in US-172 so this is safe.
        return await AVAudioApplication.requestRecordPermission()
    }

    // MARK: - Control

    public func start() async {
        guard !isRecording else { return }
        // Clear the prior session's finalized segment so the bound view never
        // re-applies a stale final value on the next dictation (US-1230).
        finalizedText = nil
        do {
            try await beginSession()
            isRecording = true
            lastError = nil
        } catch {
            lastError = error
            stop()
        }
    }

    /// Tear down the engine, recognizer, tap, and audio session. Idempotent
    /// (US-1230): the tap-removal and session-deactivation each run at most once
    /// per activation, so a second call — or the error+final double callback —
    /// is a safe no-op and never touches a session this instance didn't own.
    public func stop() {
        isRecording = false
        audioEngine.stop()
        if didInstallTap {
            audioEngine.inputNode.removeTap(onBus: 0)
            didInstallTap = false
        }
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        // US-1178: release the audio session so other apps' audio isn't left
        // ducked (the session is activated with .duckOthers in start()) — but
        // only the session we activated, exactly once (US-1230).
        if didActivateSession {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            didActivateSession = false
        }
    }

    public func reset() {
        stop()
        recognizedText = ""
        finalizedText = nil
    }

    // MARK: - Session setup

    private func beginSession() async throws {
        guard let recognizer, recognizer.isAvailable else {
            throw DictationError.recognizerUnavailable
        }

        // Re-check permissions inline so a caller that skipped
        // `requestPermissions()` still gets a clean failure.
        let speechStatus = SFSpeechRecognizer.authorizationStatus()
        if speechStatus == .notDetermined {
            let granted = await requestPermissions()
            if !granted {
                throw DictationError.speechPermissionDenied
            }
        } else if speechStatus != .authorized {
            throw DictationError.speechPermissionDenied
        }
        if AVAudioApplication.shared.recordPermission != .granted {
            let granted = await AVAudioApplication.requestRecordPermission()
            if !granted { throw DictationError.microphonePermissionDenied }
        }

        // Configure the shared audio session for record. `.measurement`
        // mode is the right choice for speech because it disables
        // automatic gain control + filters that smear consonants.
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        didActivateSession = true

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        // We always have a live connection — but partial recognition can
        // be served on-device too. Don't force on-device because it
        // restricts the language model.
        self.request = request

        // Capture the input node's current format BEFORE installing the
        // tap; iOS picks the right hardware format for record category.
        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [request] buffer, _ in
            // Tap callback runs on a private real-time (audio IO) thread. Append
            // to the request captured HERE — SFSpeechAudioBufferRecognitionRequest
            // is thread-safe for append. Do NOT read `self.request`: that property
            // is @MainActor-isolated and `stop()` nils it on the main actor, so an
            // unsynchronized load of it from this audio thread is a data race
            // (TSan-detectable; torn read under strict concurrency). Capturing the
            // request directly touches no isolated `self` state and forms no cycle
            // (the request doesn't retain self); the tap is removed in stop(), which
            // releases this capture.
            request.append(buffer)
        }
        didInstallTap = true

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            throw DictationError.engineFailure(error.localizedDescription)
        }

        recognizedText = ""
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let result {
                    let transcript = result.bestTranscription.formattedString
                    self.recognizedText = transcript
                    if result.isFinal {
                        // Publish the final segment BEFORE stop() flips
                        // isRecording=false, so the bound view can apply it even
                        // though the recognizedText path is now guard-gated (US-1230).
                        self.finalizedText = transcript
                        self.stop()
                    }
                }
                if error != nil {
                    self.stop()
                }
            }
        }
    }
}
