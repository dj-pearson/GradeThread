import SwiftUI

// US-2504 AC2/AC4: the screen. Record a walk-around, review it, send it, and
// watch honest progress while it goes.
//
// Three steps, and the middle one is not decoration: a seller who just recorded
// 40 seconds should see what they are about to spend an upload on before it
// starts, because the refusals that arrive after an upload are the ones this
// whole story is about.

struct WalkAroundGradeView: View {
    let request: VideoGradeRequest
    /// How many photos are staged for this item right now.
    ///
    /// Photos and a clip in one submission are REFUSED, and it is a 400 that
    /// arrives after the upload. The screen therefore has to know, and the
    /// entry point has to make video a MODE that clears staged photos rather
    /// than an addition to them.
    let stagedPhotoCount: Int
    var onGraded: (String) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss
    @State private var recorder = WalkAroundRecorder()
    @State private var uploader = VideoGradeUploader()

    var body: some View {
        content
            .navigationTitle("Walk-around")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        recorder.teardown()
                        dismiss()
                    }
                    .disabled(isSending)
                }
            }
            .task { await recorder.prepare() }
            .onDisappear { recorder.teardown() }
    }

    @ViewBuilder
    private var content: some View {
        if isSending || isFinished {
            progressStep
        } else {
            switch recorder.phase {
            case .idle, .preparing:
                preparing
            case .ready, .recording:
                captureStep
            case .finished(let clip):
                reviewStep(clip)
            case .failed(let message):
                failure(message)
            }
        }
    }

    // MARK: - Steps

    private var preparing: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Starting the camera...")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var captureStep: some View {
        VStack(spacing: 0) {
            CameraPreview(session: recorder.session)
                .ignoresSafeArea(edges: .horizontal)
            VStack(spacing: 12) {
                Text(Self.captureHint(isRecording: isRecording))
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal)
                if isRecording {
                    // Counts DOWN, not up. "18 seconds left" is the number that
                    // changes what the seller does; "27 seconds elapsed" is a
                    // fact about the past.
                    Text(Self.remainingText(elapsed: recorder.elapsedSeconds))
                        .font(.title3.weight(.semibold))
                        .monospacedDigit()
                    ProgressView(value: recorder.progress)
                        .padding(.horizontal, 40)
                }
                Button {
                    if isRecording { recorder.stopRecording() } else { recorder.startRecording() }
                } label: {
                    Text(isRecording ? "Stop" : "Record")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent)
                .tint(isRecording ? Color.brandRed : Color.brandNavy)
                .padding(.horizontal, 24)
                .accessibilityLabel(isRecording ? "Stop recording" : "Start recording")
            }
            .padding(.vertical, 20)
        }
    }

    private func reviewStep(_ clip: WalkAroundClip) -> some View {
        List {
            Section {
                LabeledContent("Length", value: Self.lengthText(clip.durationSeconds))
                LabeledContent("Size", value: Self.sizeText(clip.bytes))
            } header: {
                Text("Your clip")
            } footer: {
                Text(Self.reviewFooter(clip: clip, stagedPhotoCount: stagedPhotoCount))
            }
            Section {
                Button {
                    Task {
                        await uploader.submit(
                            clip: clip,
                            request: request,
                            stagedPhotoCount: stagedPhotoCount)
                    }
                } label: {
                    Text("Grade this clip").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(rejection(for: clip) != nil)
                Button("Record again") { recorder.discard(clip) }
            }
        }
    }

    private var progressStep: some View {
        VStack(spacing: 16) {
            switch uploader.phase {
            case .uploading(let fraction):
                ProgressView(value: fraction)
                    .padding(.horizontal, 40)
            case .grading:
                // Indeterminate ON PURPOSE. The server sends nothing while it
                // extracts frames and grades, so a determinate bar here would be
                // an invented number, and a bar parked at 100% is
                // indistinguishable from a hang.
                ProgressView()
            default:
                EmptyView()
            }
            Text(VideoGradeUploader.statusText(for: uploader.phase))
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
            if case .finished(let outcome) = uploader.phase {
                finished(outcome)
            }
            if case .failed = uploader.phase {
                Button("Back") { uploader.reset() }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func finished(_ outcome: VideoGradeOutcome) -> some View {
        switch outcome {
        case .graded(let submissionId):
            Button("See the grade") {
                onGraded(submissionId)
                dismiss()
            }
            .buttonStyle(.borderedProminent)
        case .needsPhotos(_, let reason, let requested):
            VStack(alignment: .leading, spacing: 8) {
                // Says the money part FIRST. "We couldn't grade it" reads like a
                // wasted purchase until you know it was not one.
                Text("You weren't charged for this.")
                    .font(.subheadline.weight(.semibold))
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                ForEach(requested, id: \.self) { line in
                    Text(line).font(.caption).foregroundStyle(.secondary)
                }
                Button("Record again") { uploader.reset() }
            }
            .padding(.horizontal, 24)
        }
    }

    private func failure(_ message: String) -> some View {
        VStack(spacing: 12) {
            Text(message)
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
            Button("Try again") { Task { await recorder.prepare() } }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - State helpers

    private var isRecording: Bool {
        if case .recording = recorder.phase { return true }
        return false
    }

    private var isSending: Bool {
        switch uploader.phase {
        case .uploading, .grading: return true
        default: return false
        }
    }

    private var isFinished: Bool {
        switch uploader.phase {
        case .finished, .failed: return true
        default: return false
        }
    }

    private func rejection(for clip: WalkAroundClip) -> String? {
        VideoGradingContract.rejection(
            bytes: clip.bytes,
            durationSeconds: clip.durationSeconds,
            format: clip.format,
            stagedPhotoCount: stagedPhotoCount)
    }

    // MARK: - Copy

    nonisolated static func captureHint(isRecording: Bool) -> String {
        isRecording
            ? "Turn the garment slowly. Front, back, the label, then anything you'd photograph close up."
            : "One take, up to 45 seconds. We read the front, back, label and detail views out of it."
    }

    /// Counts down. The number that matters is how long is LEFT.
    nonisolated static func remainingText(elapsed: Double) -> String {
        let remaining = max(0, VideoGradingContract.maxDurationSeconds - elapsed)
        return "\(Int(remaining.rounded(.up)))s left"
    }

    /// "Not readable" rather than a dash or a zero. The server refuses a clip
    /// whose length it cannot parse, so the seller should see the reason on the
    /// review step instead of meeting it after an upload.
    nonisolated static func lengthText(_ seconds: Double?) -> String {
        guard let seconds else { return "Not readable" }
        return "\(Int(seconds.rounded()))s"
    }

    nonisolated static func sizeText(_ bytes: Int) -> String {
        let mb = Double(bytes) / (1024 * 1024)
        return mb < 1
            ? "\(max(1, bytes / 1024)) KB"
            : String(format: "%.1f MB", mb)
    }

    /// The review step's one line. When the clip WILL be refused, this says why
    /// before the seller spends the upload finding out.
    nonisolated static func reviewFooter(clip: WalkAroundClip, stagedPhotoCount: Int) -> String {
        if let rejection = VideoGradingContract.rejection(
            bytes: clip.bytes,
            durationSeconds: clip.durationSeconds,
            format: clip.format,
            stagedPhotoCount: stagedPhotoCount
        ) {
            return rejection
        }
        return "If the clip doesn't show a required view, we'll say so and you won't be charged."
    }
}
