import SwiftUI

/// Live progress for an AutoLister run: the prep pipeline (create items + upload
/// + classify) then the generation queue (per-job status, photo-QA nudges,
/// retry). Owns the `AutoListerGenerator` and starts it on appear.
struct AutoListerQueueView: View {
    let groups: [PreparedGroup]
    let uploadService: PhotoUploadService
    let uploadStore: PhotoUploadStore

    @StateObject private var generator = AutoListerGenerator()
    @State private var didStart = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        content
            .navigationTitle("Generating")
            .navigationBarTitleDisplayMode(.inline)
            .task {
                guard !didStart else { return }
                didStart = true
                await generator.run(groups: groups, uploadService: uploadService, uploadStore: uploadStore)
            }
    }

    @ViewBuilder
    private var content: some View {
        switch generator.prep {
        case .idle, .running:
            preparing
        case .failed(let message):
            failure(message)
        case .finished:
            queue
        }
    }

    // MARK: - Preparing

    private var preparing: some View {
        VStack(spacing: 16) {
            ProgressView()
                .controlSize(.large)
            Text(preparingLabel)
                .font(.headline)
            Text("Creating items and uploading photos — keep the app open.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var preparingLabel: String {
        if case .running(let done, let total) = generator.prep {
            return "Preparing items \(done)/\(total)…"
        }
        return "Preparing…"
    }

    private func failure(_ message: String) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 40))
                .foregroundStyle(Color.brandRed)
            Text("Couldn't start generation")
                .font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Back") { dismiss() }
                .buttonStyle(.bordered)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Queue

    private var queue: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    ProgressView(value: generator.batch.progress)
                        .tint(Color.brandNavy)
                    Text(summaryLabel)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
            }

            if !nudges.isEmpty {
                Section("Photo quality") {
                    ForEach(nudges, id: \.itemId) { result in
                        Label(nudgeMessage(result), systemImage: "camera.badge.ellipsis")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Section("Items") {
                ForEach(generator.batch.jobs) { job in
                    jobRow(job)
                }
            }

            if generator.batch.isTerminal {
                Section {
                    if generator.batch.hasFailures {
                        Button {
                            Task { await generator.batch.retryFailed() }
                        } label: {
                            Label("Retry failed", systemImage: "arrow.clockwise")
                        }
                    }
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func jobRow(_ job: AutolisterJob) -> some View {
        HStack(spacing: 12) {
            statusIcon(job.status)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text("Item \(job.inventoryItemId.prefix(8))")
                    .font(.subheadline)
                    .monospaced()
                if job.status == .failed, let error = job.error {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(Color.brandRed)
                        .lineLimit(2)
                }
            }
            Spacer()
        }
        .accessibilityLabel("Item \(job.inventoryItemId.prefix(8)), \(job.status.rawValue)")
    }

    @ViewBuilder
    private func statusIcon(_ status: AutolisterJobStatus) -> some View {
        switch status {
        case .pending:
            Image(systemName: "clock").foregroundStyle(.secondary)
        case .running:
            ProgressView().controlSize(.small)
        case .success:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.brandEmerald)
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Color.brandRed)
        }
    }

    // MARK: - Derived

    private var summaryLabel: String {
        guard let batch = generator.batch.batch else { return "Starting…" }
        switch generator.batch.phase {
        case .completed:
            return "Done — \(batch.succeededCount) listing\(batch.succeededCount == 1 ? "" : "s") generated."
        case .partial:
            return "\(batch.succeededCount) generated, \(batch.failedCount) failed."
        case .failed(let message):
            return message
        default:
            return "Generating \(batch.succeededCount + batch.failedCount)/\(batch.itemCount)…"
        }
    }

    /// Items whose photos likely need reshooting (errored, low score, or with
    /// flagged issues). Sorted for a stable list.
    private var nudges: [PhotoQaResult] {
        generator.batch.photoQa.values
            .filter { $0.score < 0 || $0.score < 60 || !$0.issues.isEmpty }
            .sorted { $0.itemId < $1.itemId }
    }

    private func nudgeMessage(_ result: PhotoQaResult) -> String {
        if let issue = result.issues.first { return issue.message }
        if result.score < 0 { return "Couldn't assess photos for item \(result.itemId.prefix(8))." }
        return "Photos for item \(result.itemId.prefix(8)) scored low — consider reshooting."
    }
}
