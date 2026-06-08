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
                .disabled(store.isSyncing)
                if !staged.isEmpty {
                    Text("\(staged.count) photo\(staged.count == 1 ? "" : "s") staged")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
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
                    Label("Synced \(count) photo\(count == 1 ? "" : "s") to a reconcile session. Open the web board to cluster + finish.", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                case .failed(let message):
                    Label(message, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.red)
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
        for result in results {
            let capturedAt = result.creationDate() ?? .now
            guard let image = await result.loadImage(),
                  let output = await PhotoCompressor.compressOffMain(image) else { continue }
            staged.append(
                PhotoCapture(
                    imageData: output.imageData,
                    thumbnail: output.thumbnail,
                    capturedAt: capturedAt,
                    source: .library
                )
            )
        }
    }
}
