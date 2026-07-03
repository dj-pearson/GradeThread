import PhotosUI
import SwiftUI

/// Photo-dump → reconcile-session intake (US-289). The reseller multi-selects a
/// batch of garment photos and sends them into a NEW reconcile session that the
/// web board opens to cluster (by capture-time gaps) and commit into items.
/// This is the "target a session, not a single item" entry point: unlike normal
/// intake, no inventory_item is created here — the photos are staged to storage
/// and the web board decides how they group.
struct ReconcileIntakeView: View {
    let ownerId: String
    @State private var store: ReconcileIntakeStore
    @State private var staged: [PhotoCapture] = []
    @State private var showPicker = false
    // US-1197: feedback when some picks fail to load, and a non-dead-end success.
    @State private var ingesting = false
    @State private var ingestDropped = 0

    /// The web reconcile board that finishes clustering the synced photos.
    private static let webBoardURL = URL(string: "https://gradethread.com/dashboard/flipdesk/reconciliation")!

    init(ownerId: String) {
        self.ownerId = ownerId
        _store = State(initialValue: ReconcileIntakeStore(ownerId: ownerId))
    }

    var body: some View {
        List {
            Section {
                Button {
                    showPicker = true
                } label: {
                    Label("Select photos", systemImage: "photo.on.rectangle.angled")
                }
                .disabled(store.isSyncing || ingesting)
                if ingesting {
                    HStack { ProgressView(); Text("Loading photos…").foregroundStyle(.secondary) }
                        .font(.subheadline)
                }
                if !staged.isEmpty {
                    Text("\(staged.count) photo\(staged.count == 1 ? "" : "s") staged")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                if ingestDropped > 0 {
                    // US-1197: surface skipped picks instead of a silent no-op.
                    Label("Couldn't load \(ingestDropped) photo\(ingestDropped == 1 ? "" : "s") — they may still be downloading from iCloud.", systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(Color.brandAmber)
                }
            } footer: {
                Text("Pick a batch of photos from a sourcing haul. They sync into a reconcile session — open the web board to group them into items and finish.")
            }

            if !staged.isEmpty {
                Section {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(staged) { capture in
                                Image(uiImage: capture.thumbnail)
                                    .resizable()
                                    .scaledToFill()
                                    .frame(width: 64, height: 64)
                                    .clipShape(RoundedRectangle(cornerRadius: CornerRadius.chip))
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
            }

            Section {
                switch store.phase {
                case .idle:
                    EmptyView()
                case .syncing(let done, let total):
                    HStack {
                        ProgressView()
                        Text("Syncing \(done)/\(total)…")
                    }
                case .completed(let count):
                    // US-1197: not a dead end — offer the web board link and a
                    // way to start another batch instead of a frozen success.
                    VStack(alignment: .leading, spacing: 10) {
                        Label("Synced \(count) photo\(count == 1 ? "" : "s") to a reconcile session.", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.brandEmerald)
                        Link(destination: Self.webBoardURL) {
                            Label("Open the web board to cluster + finish", systemImage: "arrow.up.right.square")
                        }
                        .font(.subheadline.weight(.semibold))
                        Button {
                            staged = []
                            ingestDropped = 0
                            store.phase = .idle
                        } label: {
                            Label("Start another batch", systemImage: "plus.circle")
                        }
                        .font(.subheadline)
                    }
                case .failed(let message):
                    // US-1163: the staged photos are retained on failure (only
                    // cleared on success), so make the retry path explicit.
                    VStack(alignment: .leading, spacing: 4) {
                        Label(message, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                        Text("Your photos are still staged — tap Sync to try again.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }

                Button {
                    Task {
                        let captures = staged
                        if await store.sync(captures) != nil { staged = [] }
                    }
                } label: {
                    Label("Sync to reconcile session", systemImage: "arrow.up.circle")
                }
                .disabled(staged.isEmpty || store.isSyncing)
            }
        }
        .navigationTitle("Reconcile photos")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showPicker) {
            PhotoLibraryPicker(selectionLimit: 30) { results in
                Task { await ingest(results) }
            }
            .ignoresSafeArea()
        }
    }

    /// Compresses + EXIF-strips each pick, capturing the original PHAsset
    /// creationDate BEFORE the strip (US-289) so the web board can time-cluster.
    private func ingest(_ results: [PHPickerResult]) async {
        guard !results.isEmpty else { return }
        ingesting = true
        ingestDropped = 0
        defer { ingesting = false }
        var dropped = 0
        for result in results {
            let capturedAt = result.creationDate() ?? .now
            guard let image = await result.loadImage(),
                  let output = await PhotoCompressor.compressOffMain(image) else {
                dropped += 1   // US-1197: count rather than silently skip
                continue
            }
            staged.append(
                PhotoCapture(
                    imageData: output.imageData,
                    thumbnail: output.thumbnail,
                    capturedAt: capturedAt,
                    source: .library,
                    // US-1547: provenance filename → item_photos.original_filename.
                    sourceName: result.itemProvider.suggestedName
                )
            )
        }
        ingestDropped = dropped
    }
}
