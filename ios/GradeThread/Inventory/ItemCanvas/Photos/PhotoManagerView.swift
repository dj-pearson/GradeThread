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
    // US-1296+: a photo edit (rotate/reorder/retag/delete) was made this session.
    // Each edit persists locally immediately; we push the result to the live eBay
    // listing ONCE, when the sheet closes — coalescing a burst of edits into a
    // single revise instead of a full photo re-PUT per micro-edit (eBay rate
    // limits). The manual "Sync photo order to eBay" button clears this so closing
    // afterward doesn't double-push.
    @State private var photosChanged = false
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
        // Coalesced auto-resync on close: push the net result of this session's
        // photo edits to the live eBay listing once, however the sheet is
        // dismissed (Done or swipe).
        .onDisappear { syncOnCloseIfNeeded() }
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
        // US-2468: the ROLE is part of a photo's identity now, so a retag that
        // only changes the role (Detail → Fabric close-up) must still re-seed
        // the working copy. Without it the row keeps its old label until the
        // sheet is reopened.
        photos.map { "\($0.id)|\($0.sortOrder)|\($0.photoType)|\($0.photoRole ?? "")" }
            .joined(separator: ",")
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
                Button("Done") {
                    syncOnCloseIfNeeded()
                    dismiss()
                }.disabled(isSaving)
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
        // US-2468: the free-text garment word picks the clothing sub-profile,
        // so a t-shirt is never offered an inseam slot and a blazer IS offered a
        // shoulder. item_category alone cannot tell those apart.
        let profile = photoProfileStore.profile(
            for: item.itemCategory,
            garment: item.garmentCategory ?? item.garmentType
        )
        let position = working.firstIndex(where: { $0.id == photo.id })
        PhotoManagerRow(photo: photo, isCover: isCover)
            .contextMenu { rowContextMenu(for: photo, isCover: isCover, profile: profile) }
            // US-2534: VoiceOver reads the row as one element naming the slot,
            // its position, and whether it is the cover — position matters here
            // because the ORDER is the data: the top photo is the cover and the
            // main eBay image.
            .accessibilityElement(children: .combine)
            .accessibilityLabel(rowAccessibilityLabel(for: photo, isCover: isCover, at: position))
            // US-2534: the reorder alternative AC2 asks for. `.onMove` is a
            // drag, which VoiceOver and Switch Control cannot perform, so
            // without these the screen's primary function is unreachable rather
            // than merely awkward. Same idiom as PhotoIntakeView's delete action
            // (US-704), for the same reason.
            .accessibilityActions {
                if let position, position > 0 {
                    Button("Move up") { moveRow(from: position, to: position - 1) }
                }
                if let position, position < working.count - 1 {
                    Button("Move down") { moveRow(from: position, to: position + 2) }
                }
                if !isCover {
                    Button("Set as cover") { setCover(photo) }
                }
                Button("Rotate right") { rotate(photo, clockwise: true) }
                Button("Rotate left") { rotate(photo, clockwise: false) }
            }
    }

    /// What VoiceOver reads for one row. Position is 1-based and spoken,
    /// because "photo 3 of 7" is the only way a non-sighted user can tell where
    /// a move landed — the visual order is the entire feedback channel here.
    private func rowAccessibilityLabel(
        for photo: LocalItemPhoto,
        isCover: Bool,
        at position: Int?
    ) -> String {
        let slot = FlipdeskPhotoType.label(for: photo.photoType, role: photo.photoRole)
        var parts = [slot]
        if let position {
            parts.append("photo \(position + 1) of \(working.count)")
        }
        if isCover {
            parts.append("cover photo")
        }
        return parts.joined(separator: ", ")
    }

    /// Reorder from an accessibility action. Routes through the SAME `move`
    /// the drag uses, so the persistence and the dirty-marking cannot diverge
    /// between the two paths — which is exactly how an accessible alternative
    /// ends up saving nothing.
    private func moveRow(from source: Int, to destination: Int) {
        move(from: IndexSet(integer: source), to: destination)
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

    /// US-2468: one choice in the retag menu. Identity is the (type, role)
    /// PAIR — a suit profile offers three separate `tag` slots, so keying the
    /// menu on the type alone would collapse them into one entry.
    private struct TagChoice: Identifiable {
        let type: String
        let role: String?
        let label: String
        var id: String { PhotoProfile.slotKey(type, role) }
    }

    @ViewBuilder
    private func changeTypeMenu(for photo: LocalItemPhoto, profile: PhotoProfile) -> some View {
        let current = PhotoProfile.slotKey(photo.photoType, photo.photoRole)

        // Suggested = this item's own profile, in CAPTURE order (Front → Back →
        // Tag → Detail → measurements), because that is the order a seller
        // shoots in and so the next tag they want is the next one down.
        // Deduped by slot key: ForEach over duplicate Identifiable ids is a
        // SwiftUI runtime fault, and a profile is server data — this client
        // must not fault on a table it did not author.
        var seen = Set<String>()
        let suggested = profile.roles
            // US-2461: a profile is server data this client did not author, so a
            // stale row naming a retired type must not put it back in the
            // picker. Web and Android both filter here; iOS did not.
            .filter { !FlipdeskPhotoType.isRetired($0.type) }
            .map { TagChoice(type: $0.type, role: $0.role, label: $0.label) }
            .filter { seen.insert($0.id).inserted }
        let suggestedIds = seen

        // Everything else, A-Z by label so a rare tag is findable by name.
        // Retired types are never offered as a NEW choice; a photo already on
        // one keeps its old label until it is retagged (see the orphan row).
        //
        // US-2461: this enumerates ROLES, not bare types. It used to map every
        // type to `(type, nil)`, which meant a role the item's profile did not
        // happen to suggest was UNREACHABLE on a phone rather than demoted —
        // "Hem & stitching" and "Made in / union label" simply did not exist —
        // while the menu offered a bare "Detail" that web deliberately
        // suppresses. That is hiding, and the rule is that nothing is hidden.
        let group = GarmentGroup.from(
            profile.category.split(separator: ":").last.map(String.init)
        )
        let rest = FlipdeskPhotoType.all
            .filter { !FlipdeskPhotoType.isRetired($0) }
            .flatMap { type -> [TagChoice] in
                let roles = PhotoRoleVocabulary.roles(for: type, group: group)
                if !roles.isEmpty {
                    return roles.map { TagChoice(type: type, role: $0.key, label: $0.label) }
                }
                // `measurement` takes roles, but only the profile knows which —
                // so it contributes whatever the profile suggested and never a
                // bare, unqualified measurement, which is the MeasureCard
                // calibration frame rather than a tape close-up.
                if PhotoRoleVocabulary.takesRole(type) { return [] }
                return [TagChoice(type: type, role: nil, label: FlipdeskPhotoType.label(for: type))]
            }
            .filter { !suggestedIds.contains($0.id) }
            .sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }

        // US-2461: the orphan row. A photo whose current slot is offered by
        // neither section — a row migration 00587 has not reached, or a bare
        // `detail` from before the qualifier existed — would otherwise show
        // nothing checked, leaving the seller unable to tell what they are
        // changing FROM. The comment above has claimed this row existed since
        // US-2468; it did not. Web (`photo-tag-select.tsx`) and Android
        // (`PhotoTagOptions.orphan`) both have it.
        let offered = suggestedIds.union(rest.map(\.id))
        let orphan: TagChoice? = offered.contains(current)
            ? nil
            : TagChoice(
                type: photo.photoType,
                role: photo.photoRole,
                label: FlipdeskPhotoType.label(
                    for: photo.photoType,
                    role: photo.photoRole,
                    profile: profile
                )
            )

        Menu {
            if let orphan {
                Section {
                    tagChoiceButton(photo: photo, choice: orphan, current: current)
                }
            }
            Section("Suggested · \(profile.label)") {
                ForEach(suggested) { choice in
                    tagChoiceButton(photo: photo, choice: choice, current: current)
                }
            }
            Section("All types") {
                ForEach(rest) { choice in
                    tagChoiceButton(photo: photo, choice: choice, current: current)
                }
            }
        } label: {
            Label("Change type", systemImage: "tag")
        }
    }

    @ViewBuilder
    private func tagChoiceButton(
        photo: LocalItemPhoto,
        choice: TagChoice,
        current: String
    ) -> some View {
        let isCurrent = choice.id == current
        Button {
            retag(photo, to: choice.type, role: choice.role)
        } label: {
            if isCurrent {
                Label(choice.label, systemImage: "checkmark")
            } else {
                Text(choice.label)
            }
        }
        .disabled(isCurrent)
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
        photosChanged = true
        Task { await runDelete(photo) }
    }

    private func persistOrder() {
        photosChanged = true
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

    private func retag(_ photo: LocalItemPhoto, to serverType: String, role: String?) {
        AppRouter.haptic()
        photosChanged = true
        Task {
            isSaving = true
            defer { isSaving = false }
            do {
                // LocalItemPhoto is @Model (observable) — the row label
                // refreshes on mutation without touching `working`.
                try await PhotoEditService().retag(photo, to: serverType, role: role, context: modelContext)
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
                // Manual push already reconciled eBay — don't push again on close.
                photosChanged = false
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
        photosChanged = true
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

    /// Coalesced auto-resync fired when the sheet closes (Done or swipe). Each
    /// edit already wrote through to the server, so this just re-pushes the net
    /// photo set to the live eBay listing once. Fire-and-forget: the view is gone,
    /// so a failure surfaces on the listing (publish_error) + next sync pull
    /// rather than inline. No-op when nothing changed or there's no live listing.
    private func syncOnCloseIfNeeded() {
        guard photosChanged, let listing = liveListing else { return }
        photosChanged = false
        let listingId = listing.id
        Task {
            _ = await EbayPublishService().revise(listingId: listingId, syncPhotos: true)
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
                Text(FlipdeskPhotoType.label(for: photo.photoType, role: photo.photoRole))
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
