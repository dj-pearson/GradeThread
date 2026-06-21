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
        do {
            try await beginSession()
            isRecording = true
            lastError = nil
        } catch {
            lastError = error
            stop()
        }
    }

    public func stop() {
        isRecording = false
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        // US-1178: release the audio session so other apps' audio isn't left
        // ducked (the session is activated with .duckOthers in start()).
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    public func reset() {
        stop()
        recognizedText = ""
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
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            // Tap callback runs on a private real-time thread. Hand the
            // buffer to the request directly (it's thread-safe). State
            // updates on `self` happen via the recognition-task callback
            // which we bounce to main below.
            self?.request?.append(buffer)
        }

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
                    self.recognizedText = result.bestTranscription.formattedString
                    if result.isFinal { self.stop() }
                }
                if error != nil {
                    self.stop()
                }
            }
        }
    }
}
