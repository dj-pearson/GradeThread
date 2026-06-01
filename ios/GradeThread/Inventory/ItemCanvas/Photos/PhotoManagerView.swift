import SwiftData
import SwiftUI

/// Reorder / set-cover / delete the photos on an item. Presented as a sheet
/// from ``ItemCanvasView``. The top row is the cover (drives the grid
/// thumbnail + eBay main image); drag to reorder, swipe to delete,
/// long-press for "Set as cover". Each change persists immediately.
struct PhotoManagerView: View {
    let item: LocalInventoryItem
    /// Photos in current sort order, passed in from the canvas `@Query`.
    let photos: [LocalItemPhoto]

    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext

    @State private var working: [LocalItemPhoto] = []
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(working) { photo in
                        let isCover = working.first?.id == photo.id
                        PhotoManagerRow(photo: photo, isCover: isCover)
                            .contextMenu {
                                if !isCover {
                                    Button {
                                        setCover(photo)
                                    } label: {
                                        Label("Set as cover", systemImage: "star")
                                    }
                                }
                            }
                    }
                    .onMove(perform: move)
                    .onDelete(perform: deleteAt)
                } footer: {
                    Text("The top photo is the cover — it's the thumbnail in your inventory and the main image on eBay.")
                }
            }
            .navigationTitle("Photos")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { EditButton() }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }.disabled(isSaving)
                }
            }
            .overlay {
                if isSaving {
                    ProgressView()
                        .padding(20)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
                }
            }
            .alert(
                "Couldn't update photos",
                isPresented: Binding(
                    get: { errorMessage != nil },
                    set: { if !$0 { errorMessage = nil } }
                )
            ) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(errorMessage ?? "")
            }
        }
        .onAppear {
            if working.isEmpty { working = photos }
        }
    }

    // MARK: - Mutations

    private func move(from source: IndexSet, to destination: Int) {
        working.move(fromOffsets: source, toOffset: destination)
        AppRouter.haptic()
        persistOrder()
    }

    private func setCover(_ photo: LocalItemPhoto) {
        guard let index = working.firstIndex(where: { $0.id == photo.id }) else { return }
        working = PhotoOrdering.movedToCover(working, from: index)
        AppRouter.haptic()
        persistOrder()
    }

    private func deleteAt(_ offsets: IndexSet) {
        guard let index = offsets.first, working.indices.contains(index) else { return }
        let photo = working[index]
        working.remove(atOffsets: offsets)
        Task { await runDelete(photo) }
    }

    private func persistOrder() {
        let snapshot = working
        Task {
            isSaving = true
            defer { isSaving = false }
            do {
                try await PhotoEditService().persistOrder(snapshot, item: item, context: modelContext)
            } catch {
                // Roll the working copy back to the persisted order on failure.
                working = photos
                errorMessage = error.localizedDescription
            }
        }
    }

    private func runDelete(_ photo: LocalItemPhoto) async {
        isSaving = true
        defer { isSaving = false }
        do {
            try await PhotoEditService().delete(
                photo, remaining: working, item: item, context: modelContext
            )
        } catch {
            working = photos
            errorMessage = error.localizedDescription
        }
    }
}

/// One photo row in the manager: thumbnail, type, and a cover badge.
private struct PhotoManagerRow: View {
    let photo: LocalItemPhoto
    let isCover: Bool

    var body: some View {
        HStack(spacing: 12) {
            AsyncImage(url: URL(string: photo.thumbnailURL ?? photo.photoURL)) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFill()
                case .empty, .failure:
                    Image(systemName: "photo")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Color.secondary.opacity(0.12))
                @unknown default:
                    EmptyView()
                }
            }
            .frame(width: 56, height: 56)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

            VStack(alignment: .leading, spacing: 3) {
                Text(photo.photoType.capitalized)
                    .font(.subheadline)
                if isCover {
                    Label("Cover", systemImage: "star.fill")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Color.brandNavy)
                }
            }
            Spacer()
        }
        .padding(.vertical, 2)
    }
}
