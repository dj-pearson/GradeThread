import SwiftData
import SwiftUI

/// Live progress for an AutoLister run: the prep pipeline (create items + upload
/// + classify) then the generation queue (per-job status, photo-QA nudges,
/// retry). Owns the `AutoListerGenerator` and starts it on appear.
struct AutoListerQueueView: View {
    let groups: [PreparedGroup]
    let uploadService: PhotoUploadService
    let uploadStore: PhotoUploadStore
    /// US-674: optional listing template applied to every generated draft.
    var templateId: String? = nil

    @StateObject private var generator = AutoListerGenerator()
    @State private var didStart = false
    @Environment(\.dismiss) private var dismiss
    // US-1179: resolve each job's item title so a row reads the garment, not a
    // raw UUID prefix. The cataloging step has already created the items locally.
    @Query private var items: [LocalInventoryItem]

    private var titlesById: [String: String] {
        Dictionary(
            items.compactMap { $0.title.isEmpty ? nil : ($0.id, $0.title) },
            uniquingKeysWith: { first, _ in first }
        )
    }

    var body: some View {
        content
            .navigationTitle("Generating")
            .navigationBarTitleDisplayMode(.inline)
            .task {
                guard !didStart else { return }
                didStart = true
                await generator.run(
                    groups: groups,
                    uploadService: uploadService,
                    uploadStore: uploadStore,
                    templateId: templateId
                )
            }
            .onChange(of: generator.batch.phase) { _, newPhase in
                switch newPhase {
                case .completed:    HapticFeedback.success(); logCompletion("completed")
                case .partial:      HapticFeedback.warning(); logCompletion("partial")
                case .failed:       HapticFeedback.error();   logCompletion("failed")
                case .disconnected: HapticFeedback.warning(); logCompletion("disconnected")
                default:            break
                }
            }
    }

    private func logCompletion(_ status: String) {
        let b = generator.batch.batch
        Telemetry.event("autolister_batch_completed", props: [
            "status": status,
            "succeeded": b?.succeededCount ?? 0,
            "failed": b?.failedCount ?? 0,
        ])
    }

    @ViewBuilder
    private var content: some View {
        switch generator.prep {
        case .idle, .running:
            preparing
        case .failed(let message):
            failure(message)
        case .timedOut(let pending, let total):
            timeoutWarning(pending: pending, total: total)
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
                .font(.brandHeadline)
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

    // MARK: - Upload timeout

    private func timeoutWarning(pending: Int, total: Int) -> some View {
        VStack(spacing: 16) {
            Image(systemName: "clock.badge.exclamationmark")
                .scaledIconFont(size: 40)  // US-1152: scale with Dynamic Type
                .foregroundStyle(Color.brandRed)
            Text("Uploads still finishing")
                .font(.brandHeadline)
            Text("\(pending) of \(total) item\(total == 1 ? "" : "s") still \(pending == 1 ? "has" : "have") photos uploading. Retry the uploads so every listing generates from a complete photo set.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            VStack(spacing: 10) {
                Button {
                    Task { await generator.retryUploads() }
                } label: {
                    Label("Retry uploads", systemImage: "arrow.clockwise")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                Button("Generate anyway") {
                    Task { await generator.generateAnyway() }
                }
                .buttonStyle(.bordered)
                Button("Back") { dismiss() }
                    .buttonStyle(.borderless)
            }
            .padding(.top, 4)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func failure(_ message: String) -> some View {
        // US-971: both failure exits happen before any item is created, so a
        // "Try again" can safely re-run the pipeline; "Back" stays as the escape.
        ErrorStateView(
            title: "Couldn't start generation",
            message: message,
            retry: {
                await generator.retry(
                    groups: groups,
                    uploadService: uploadService,
                    uploadStore: uploadStore,
                    templateId: templateId
                )
            },
            secondaryTitle: "Back",
            secondaryAction: { dismiss() }
        )
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
                .accessibilityElement(children: .combine)
                .accessibilityLabel(summaryLabel)
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

            if case .disconnected(let message) = generator.batch.phase {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Connection lost", systemImage: "wifi.exclamationmark")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Color.brandRed)
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Button {
                        generator.batch.resume()
                    } label: {
                        Label("Resume", systemImage: "arrow.clockwise")
                    }
                    Button("Done") { dismiss() }
                }
            } else if generator.batch.isTerminal {
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
                if let title = titlesById[job.inventoryItemId] {
                    Text(title)
                        .font(.subheadline)
                        .lineLimit(1)
                } else {
                    Text("Item \(job.inventoryItemId.prefix(8))")
                        .font(.subheadline)
                        .monospaced()
                }
                if job.status == .failed, let error = job.error {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(Color.brandRed)
                        .lineLimit(2)
                }
            }
            Spacer()
        }
        .accessibilityLabel("\(titlesById[job.inventoryItemId] ?? "Item \(job.inventoryItemId.prefix(8))"), \(job.status.rawValue)")
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
        case .failed(let message), .disconnected(let message):
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
        // US-1193: show the human title (titlesById) rather than a raw UUID
        // prefix; fall back to the prefix only when the title isn't cached.
        let name = titlesById[result.itemId] ?? "item \(result.itemId.prefix(8))"
        if result.score < 0 { return "Couldn't assess photos for \(name)." }
        return "Photos for \(name) scored low — consider reshooting."
    }
}
