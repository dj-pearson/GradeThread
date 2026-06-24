import SwiftData
import SwiftUI

/// Reorder / set-cover / retag / delete the photos on an item. Presented as
/// a sheet from ``ItemCanvasView``. The top row is the cover (drives the
/// grid thumbnail + eBay main image); drag to reorder, swipe to delete,
/// long-press for "Set as cover" / "Change type". Each change persists
/// immediately.
struct PhotoManagerView: View {
    let item: LocalInventoryItem
    /// Photos in current sort order, passed in from the canvas `@Query`.
    let photos: [LocalItemPhoto]
    /// The item's live eBay listing, when one exists. Drives the "Sync photo
    /// order to eBay" action — eBay won't let you reorder photos on an
    /// inventory-based listing from its own site, so we push the new order
    /// through the revise endpoint.
    var liveListing: LocalListing? = nil

    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Environment(PhotoProfileStore.self) private var photoProfileStore

    @State private var working: [LocalItemPhoto] = []
    @State private var isSaving = false
    @State private var isSyncing = false
    @State private var syncSucceeded = false
    @State private var errorMessage: String?
    // US-1160: confirm before a swipe permanently deletes a photo + its bytes.
    @State private var pendingPhotoDelete: LocalItemPhoto?

    // The body is deliberately decomposed into per-chunk computed properties /
    // @ViewBuilder helpers. As a single expression this `List` (nested ForEach →
    // contextMenu → nested Menu with two filtered Sections, plus three
    // alert/dialog modifiers) blows the whole-module Release type-check budget
    // ("unable to type-check this expression in reasonable time"). Each helper
    // returns `some View`, so the compiler type-checks them independently.
    var body: some View {
        NavigationStack {
            photoList
        }
        .onAppear {
            if working.isEmpty { working = photos }
        }
        // US-1186: if a background sync (or the canvas's own "Add photos")
        // changes the photo set while this sheet is open, re-seed the working
        // copy so the user isn't editing/reordering a stale snapshot — but only
        // when we're not mid-save, so an in-flight mutation isn't clobbered.
        .onChange(of: photosSignature) {
            if !isSaving { working = photos }
        }
    }

    /// Stable signature of the incoming photo set (id + order + type) so the
    /// re-seed fires only when the photos actually change.
    private var photosSignature: String {
        photos.map { "\($0.id)|\($0.sortOrder)|\($0.photoType)" }.joined(separator: ",")
    }

    private var photoList: some View {
        List {
            photosSection
            syncSection
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
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: CornerRadius.control))
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
        .alert("Photos synced to eBay", isPresented: $syncSucceeded) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("The new photo order is now live on your eBay listing.")
        }
        .confirmationDialog(
            "Delete photo?",
            isPresented: Binding(
                get: { pendingPhotoDelete != nil }, set: { if !$0 { pendingPhotoDelete = nil } }
            ),
            presenting: pendingPhotoDelete
        ) { photo in
            Button("Delete photo", role: .destructive) {
                pendingPhotoDelete = nil
                confirmPhotoDelete(photo)
            }
            Button("Cancel", role: .cancel) { pendingPhotoDelete = nil }
        } message: { _ in
            Text("This permanently removes the photo. This can't be undone.")
        }
    }

    private var photosSection: some View {
        Section {
            ForEach(working) { photo in
                photoRow(for: photo)
            }
            .onMove(perform: move)
            .onDelete(perform: deleteAt)
        } footer: {
            Text("The top photo is the cover — it's the thumbnail in your inventory and the main image on eBay.")
        }
    }

    @ViewBuilder
    private func photoRow(for photo: LocalItemPhoto) -> some View {
        let isCover = working.first?.id == photo.id
        // Retag options ordered by this item's category profile: the category's
        // own roles first (with category labels), then every other type.
        let profile = photoProfileStore.profile(for: item.itemCategory)
        PhotoManagerRow(photo: photo, isCover: isCover)
            .contextMenu { rowContextMenu(for: photo, isCover: isCover, profile: profile) }
    }

    @ViewBuilder
    private func rowContextMenu(
        for photo: LocalItemPhoto,
        isCover: Bool,
        profile: PhotoProfile
    ) -> some View {
        if !isCover {
            Button {
                setCover(photo)
            } label: {
                Label("Set as cover", systemImage: "star")
            }
        }
        Button {
            rotate(photo, clockwise: true)
        } label: {
            Label("Rotate right", systemImage: "rotate.right")
        }
        Button {
            rotate(photo, clockwise: false)
        } label: {
            Label("Rotate left", systemImage: "rotate.left")
        }
        changeTypeMenu(for: photo, profile: profile)
    }

    @ViewBuilder
    private func changeTypeMenu(for photo: LocalItemPhoto, profile: PhotoProfile) -> some View {
        let suggestedTypes = Set(profile.roles.map(\.type))
        Menu {
            Section("Suggested · \(profile.label)") {
                ForEach(profile.roles, id: \.type) { role in
                    Button {
                        retag(photo, to: role.type)
                    } label: {
                        if role.type == photo.photoType {
                            Label(role.label, systemImage: "checkmark")
                        } else {
                            Text(role.label)
                        }
                    }
                    .disabled(role.type == photo.photoType)
                }
            }
            Section("All types") {
                ForEach(FlipdeskPhotoType.all.filter { !suggestedTypes.contains($0) }, id: \.self) { type in
                    Button {
                        retag(photo, to: type)
                    } label: {
                        if type == photo.photoType {
                            Label(FlipdeskPhotoType.label(for: type), systemImage: "checkmark")
                        } else {
                            Text(FlipdeskPhotoType.label(for: type))
                        }
                    }
                    .disabled(type == photo.photoType)
                }
            }
        } label: {
            Label("Change type", systemImage: "tag")
        }
    }

    @ViewBuilder
    private var syncSection: some View {
        if let listing = liveListing {
            Section {
                Button {
                    AppRouter.haptic()
                    syncToEbay(listing)
                } label: {
                    HStack(spacing: 6) {
                        if isSyncing {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "arrow.triangle.2.circlepath")
                        }
                        Text("Sync photo order to eBay")
                            .font(.subheadline.weight(.semibold))
                    }
                    .frame(maxWidth: .infinity)
                }
                .disabled(isSyncing || isSaving)
            } footer: {
                Text("This listing is live on eBay. eBay won't let you reorder or edit its photos on its own site, so push the new order from here.")
            }
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
        // Capture the target and confirm; the actual delete happens on confirm.
        pendingPhotoDelete = working[index]
    }

    private func confirmPhotoDelete(_ photo: LocalItemPhoto) {
        guard let index = working.firstIndex(where: { $0.id == photo.id }) else { return }
        working.remove(at: index)
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

    private func retag(_ photo: LocalItemPhoto, to serverType: String) {
        AppRouter.haptic()
        Task {
            isSaving = true
            defer { isSaving = false }
            do {
                // LocalItemPhoto is @Model (observable) — the row label
                // refreshes on mutation without touching `working`.
                try await PhotoEditService().retag(photo, to: serverType, context: modelContext)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    /// Persists the current order (so the freshest sequence is on the server),
    /// then pushes the photo set to the live eBay listing via the revise
    /// endpoint. Keeps every image self-hosted, which avoids eBay's "mixture of
    /// Self Hosted and EPS pictures" error you hit when editing on eBay's site.
    private func syncToEbay(_ listing: LocalListing) {
        let snapshot = working
        Task {
            isSyncing = true
            defer { isSyncing = false }
            do {
                try await PhotoEditService().persistOrder(snapshot, item: item, context: modelContext)
            } catch {
                errorMessage = error.localizedDescription
                return
            }
            let outcome = await EbayPublishService().revise(
                listingId: listing.id,
                syncPhotos: true
            )
            switch outcome {
            case .revised:
                HapticFeedback.success()
                syncSucceeded = true
            case .noOfferId:
                errorMessage = "This listing has no eBay offer yet. Publish it first, then sync."
            case .failed(let message):
                HapticFeedback.error()
                errorMessage = message
            }
        }
    }

    /// Rotates a photo 90° in place. The bytes are re-uploaded to the same
    /// storage path; when the item has a live listing, "Sync photo order to
    /// eBay" then pushes the rotated image to the listing.
    private func rotate(_ photo: LocalItemPhoto, clockwise: Bool) {
        AppRouter.haptic()
        Task {
            isSaving = true
            defer { isSaving = false }
            do {
                try await PhotoRotateService().rotate(
                    photo, clockwise: clockwise, context: modelContext
                )
            } catch {
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
            // US-979: signed URL for sensitive (private-bucket) photos.
            ItemPhotoThumbnail(
                photo: photo,
                maxDimension: 56
            ) {
                Image(systemName: "photo")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.secondary.opacity(0.12))
            }
            .frame(width: 56, height: 56)
            .clipShape(RoundedRectangle(cornerRadius: CornerRadius.chip, style: .continuous))

            VStack(alignment: .leading, spacing: 3) {
                Text(FlipdeskPhotoType.label(for: photo.photoType))
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
