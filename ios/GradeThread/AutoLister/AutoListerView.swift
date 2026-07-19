import PhotosUI
import SwiftUI
import UIKit

/// AutoLister capture + review screen. Import a batch of library photos, review
/// the auto-derived item groups (set cover, split, merge, delete), then Generate.
///
/// Generate pushes `AutoListerQueueView`, which runs the create-items → upload →
/// classify → submit pipeline via `AutoListerGenerator`. The shared upload
/// service/store come from the environment (same as `PhotoIntakeView`).
struct AutoListerView: View {
    @StateObject private var model = AutoListerReviewModel()
    @Environment(\.photoUploadService) private var uploadService
    @Environment(PhotoUploadStore.self) private var uploadStore
    @State private var showingPicker = false
    /// Set when the user taps Generate; drives the push to the queue.
    @State private var pendingGroups: [PreparedGroup]?
    // US-674: optional listing template applied to every generated draft.
    @State private var templateStore = TemplateStore()
    @State private var selectedTemplateId: String?
    // US-1160: confirm before discarding a group's imported photos.
    @State private var pendingGroupDelete: ReviewGroup?

    var body: some View {
        content
            .navigationTitle("AutoLister")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbarContent }
            .sheet(isPresented: $showingPicker) {
                // Bound the pick to the batch's remaining capacity so the seller
                // can't over-select (the batch caps at `maxBatchPhotos`). We only
                // open the picker when capacity > 0, so this is never 0
                // (PHPicker treats 0 as unlimited).
                PhotoLibraryPicker(selectionLimit: model.remainingCapacity) { results in
                    showingPicker = false
                    Task {
                        await model.importPicks(results)
                        HapticFeedback.light()
                    }
                }
                .ignoresSafeArea()
            }
            .onAppear { Telemetry.event("autolister_opened") }
            .task { await templateStore.load() }
            .alert(
                "Something went wrong",
                isPresented: Binding(
                    get: { model.actionError != nil },
                    set: { if !$0 { model.actionError = nil } }
                )
            ) {
                Button("OK", role: .cancel) { model.actionError = nil }
            } message: {
                Text(model.actionError ?? "")
            }
            .confirmationDialog(
                "Delete group?",
                isPresented: Binding(
                    get: { pendingGroupDelete != nil }, set: { if !$0 { pendingGroupDelete = nil } }
                ),
                presenting: pendingGroupDelete
            ) { group in
                Button("Delete group", role: .destructive) {
                    pendingGroupDelete = nil
                    model.deleteGroup(group.id)
                }
                Button("Cancel", role: .cancel) { pendingGroupDelete = nil }
            } message: { group in
                Text("This removes this item and its \(group.photoIds.count) imported photo\(group.photoIds.count == 1 ? "" : "s") from the batch.")
            }
            // US-1909: metered-action pre-count. A pass that needs more than one
            // window costs one AI action PER window, so the seller sees the cost
            // (and what's left this month) before any of it is spent.
            .confirmationDialog(
                "Check all groups?",
                isPresented: Binding(
                    get: { model.verifyConfirm != nil },
                    set: { if !$0 { model.verifyConfirm = nil } }
                ),
                presenting: model.verifyConfirm
            ) { confirm in
                Button("Use \(confirm.windowCount) AI actions") {
                    Task { await model.confirmVerifyPass() }
                }
                Button("Cancel", role: .cancel) { model.verifyConfirm = nil }
            } message: { confirm in
                Text(meteredMessage(
                    lead: "Too many groups for one AI pass, so checking all \(confirm.totalGroups) runs in \(confirm.windowCount) batches",
                    windowCount: confirm.windowCount
                ))
            }
            .confirmationDialog(
                "AI-group these photos?",
                isPresented: Binding(
                    get: { model.proposeConfirm != nil },
                    set: { if !$0 { model.proposeConfirm = nil } }
                ),
                presenting: model.proposeConfirm
            ) { confirm in
                Button("Use \(confirm.windowCount) AI actions") {
                    Task { await model.confirmProposePass() }
                }
                Button("Cancel", role: .cancel) { model.proposeConfirm = nil }
            } message: { confirm in
                Text(meteredMessage(
                    lead: "Too many photos for one AI pass, so grouping all \(confirm.photoCount) runs in \(confirm.windowCount) batches",
                    windowCount: confirm.windowCount
                ))
            }
            .navigationDestination(
                isPresented: Binding(
                    get: { pendingGroups != nil },
                    set: { if !$0 { pendingGroups = nil } }
                )
            ) {
                if let groups = pendingGroups, let service = uploadService {
                    AutoListerQueueView(
                        groups: groups,
                        uploadService: service,
                        uploadStore: uploadStore,
                        templateId: selectedTemplateId
                    )
                }
            }
    }

    /// Open the library picker unless the batch is already full, in which case
    /// nudge the seller to generate or remove photos instead of silently opening
    /// a picker whose picks would all be dropped by the cap.
    private func presentPicker() {
        if model.isAtCapacity {
            model.capNotice = "This batch is full (\(AutoListerReviewModel.maxBatchPhotos) photos). Generate it, or remove some photos to add more."
            return
        }
        showingPicker = true
    }

    @ViewBuilder
    private var content: some View {
        if model.isImporting && model.isEmpty {
            // US-656: shimmer skeleton instead of a bare spinner.
            ScrollView { SkeletonRows(count: 4) }
        } else if let message = model.importError {
            // US-1116: import produced nothing — explicit retry, not the empty
            // state (which reads as "the import never happened").
            importErrorState(message)
        } else if model.hasPhotosButNoGroups {
            // US-1116: photos imported but grouping yielded nothing reviewable.
            groupingErrorState
        } else if model.isEmpty {
            emptyState
        } else {
            reviewList
        }
    }

    // MARK: - Error states (US-1116)

    private func importErrorState(_ message: String) -> some View {
        ErrorStateView(
            title: "Couldn't import photos",
            message: message,
            systemImage: "photo.badge.exclamationmark",
            retryTitle: "Import photos",
            retry: { await MainActor.run { presentPicker() } }
        )
    }

    private var groupingErrorState: some View {
        ErrorStateView(
            title: "Couldn't group photos",
            message: "We couldn't sort your imported photos into items. Try grouping again, or import a fresh batch.",
            systemImage: "square.stack.3d.up.slash",
            retry: { await MainActor.run { model.regroupAll() } },
            secondaryTitle: "Import photos",
            secondaryAction: { presentPicker() }
        )
    }

    // MARK: - Empty state

    /// US-656: standardized on ContentUnavailableView (like the rest of the app)
    /// instead of an ad-hoc VStack.
    /// US-1909: the metered confirm's body — the cost, plus what's left this
    /// month when we know it (a failed lookup just omits the remainder rather
    /// than blocking the pass or guessing).
    private func meteredMessage(lead: String, windowCount: Int) -> String {
        guard let remaining = model.aiActionsRemaining else {
            return "\(lead) — \(windowCount) AI action\(windowCount == 1 ? "" : "s")."
        }
        let tail = windowCount > remaining
            ? " That's more than the \(remaining) you have left this month, so some batches won't run."
            : " You have \(remaining) left this month."
        return "\(lead) — \(windowCount) AI action\(windowCount == 1 ? "" : "s").\(tail)"
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("Batch-list with AutoLister", systemImage: "square.stack.3d.up.fill")
        } description: {
            Text("Import a batch of photos and we'll group them into items, then generate eBay listings with AI.")
        } actions: {
            Button {
                presentPicker()
            } label: {
                Label("Import photos", systemImage: "photo.on.rectangle.angled")
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .tint(Color.brandNavy)
            .accessibilityHint("Pick a batch of photos from your library to group into listings.")
        }
    }

    // MARK: - Review list

    private var reviewList: some View {
        ScrollView {
            LazyVStack(spacing: 16) {
                // Cap notice — some picks were left out because a batch is bounded
                // at `maxBatchPhotos` (keeps the serial upload from hanging).
                // Dismissible; never blocks the review list.
                if let notice = model.capNotice {
                    capNoticeBanner(notice)
                }
                // US-1548: AI grouping suggestions — advisory, one-tap apply,
                // never auto-applied. Silent when verification found nothing
                // (or failed); a small inline hint while it runs. US-1909: a
                // multi-window pass has its own progress row below, so this
                // plain hint is only for the single-window (silent) run.
                if model.verifying && model.verifyProgress == nil {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text("Checking group boundaries…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                ForEach(model.suggestions) { suggestion in
                    suggestionRow(suggestion)
                }
                if model.verifyProgress != nil || model.proposeProgress != nil {
                    passProgressRow
                }
                ForEach(model.groups) { group in
                    groupCard(group)
                }
                // US-1909: photos the seller pulled out of a group. Sorted by
                // the same four modes as the web grid; "AI group remaining"
                // proposes item boundaries over them.
                if !model.ungrouped.isEmpty {
                    ungroupedSection
                }
                // US-1909: propose boundaries the AI wasn't confident enough to
                // apply — created only on the seller's say-so.
                ForEach(model.proposalReviews) { review in
                    proposalReviewRow(review)
                }
            }
            .padding()
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) { generateBar }
    }

    /// Non-blocking banner shown when an import was capped at `maxBatchPhotos`.
    private func capNoticeBanner(_ notice: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "info.circle.fill")
                .foregroundStyle(Color.brandNavy)
                .padding(.top, 2)
            Text(notice)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            Button {
                withAnimation { model.capNotice = nil }
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .accessibilityLabel("Dismiss notice")
        }
        .padding(12)
        .background(Color.brandNavy.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color.brandNavy.opacity(0.3))
        )
    }

    /// US-1909: progress of a multi-window AI pass, with a way out. A pass stops
    /// after the in-flight window, so the seller is never stuck watching a long
    /// run they didn't mean to start.
    private var passProgressRow: some View {
        let progress = model.verifyProgress ?? model.proposeProgress
        let isVerify = model.verifyProgress != nil
        return HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            if let progress {
                Text(
                    isVerify
                        ? "Checked \(progress.done)/\(progress.total) groups…"
                        : "Proposed over \(progress.done)/\(progress.total) photos…"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Button("Stop") { model.cancelPass() }
                .buttonStyle(.bordered)
                .controlSize(.small)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - US-1909: ungrouped pool

    private var ungroupedSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Ungrouped")
                    .font(.brandHeadline)
                Spacer()
                Text("\(model.ungrouped.count) photo\(model.ungrouped.count == 1 ? "" : "s")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 8) {
                sortPicker
                Spacer(minLength: 8)
                // US-1909: mirrors the web's "AI group remaining" — a vision
                // pass over the remaining photos in order, proposing where each
                // item begins. Metered: a multi-window pass shows the AI-action
                // count before spending it.
                Button {
                    Task { await model.proposeGroupsNow() }
                } label: {
                    Label("AI group", systemImage: "sparkles")
                        .font(.caption.weight(.medium))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(model.ungrouped.count < 2 || model.proposing)
                .accessibilityHint(
                    "The AI looks at the remaining photos in order and proposes where each item begins. Uses AI actions — you'll see the count first."
                )
            }
            // LazyHStack, not HStack: the ungrouped pool holds up to ~200 photos
            // on a bulk import, and a plain HStack realizes EVERY thumbnail
            // including the ones scrolled off-screen. Each AI verify/propose
            // progress publish re-renders this strip, so the cost is paid
            // repeatedly and shows up as dropped frames mid-run.
            //
            // Same reasoning as InventoryBoardView (:34-35), which already
            // documents it for a 500+-item catalog. The per-group strip below
            // stays a plain HStack deliberately — a group is one item's photos,
            // typically 4-12, where laziness would add overhead for nothing.
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 8) {
                    ForEach(model.ungroupedSorted) { photo in
                        ungroupedThumbnail(photo)
                    }
                }
            }
        }
        .padding()
        .cardStyle(.flush)
    }

    private var sortPicker: some View {
        Menu {
            ForEach(UngroupedSortMode.allCases) { mode in
                Button {
                    model.ungroupedSort = mode
                } label: {
                    if model.ungroupedSort == mode {
                        Label(mode.label, systemImage: "checkmark")
                    } else {
                        Text(mode.label)
                    }
                }
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "arrow.up.arrow.down")
                Text(model.ungroupedSort.label)
                    .font(.caption.weight(.medium))
                    .lineLimit(1)
            }
        }
        .accessibilityLabel("Sort ungrouped photos")
    }

    private func ungroupedThumbnail(_ photo: PhotoCapture) -> some View {
        Image(uiImage: photo.thumbnail)
            .resizable()
            .scaledToFill()
            .frame(width: 92, height: 92)
            .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control))
            .contextMenu { ungroupedPhotoMenu(photo) }
            .accessibilityLabel("Ungrouped photo")
            // US-1411: mirror the context menu as accessibility actions —
            // VoiceOver and Switch Control can't open a `.contextMenu`. These
            // must be a FLAT list of buttons (a nested Menu isn't actionable
            // through the rotor), so the submenu is expanded here.
            .accessibilityActions {
                Button("New item") { model.groupUngroupedPhoto(photo.id, into: nil) }
                ForEach(model.groups) { group in
                    Button("Add to item \(model.displayIndex(of: group))") {
                        model.groupUngroupedPhoto(photo.id, into: group.id)
                    }
                }
                Button("Remove photo") { model.removePhoto(photo.id) }
            }
    }

    @ViewBuilder
    private func ungroupedPhotoMenu(_ photo: PhotoCapture) -> some View {
        Button {
            model.groupUngroupedPhoto(photo.id, into: nil)
        } label: {
            Label("New item", systemImage: "plus.rectangle")
        }
        if !model.groups.isEmpty {
            Menu("Add to…") {
                ForEach(model.groups) { group in
                    Button("Item \(model.displayIndex(of: group))") {
                        model.groupUngroupedPhoto(photo.id, into: group.id)
                    }
                }
            }
        }
        Divider()
        Button(role: .destructive) {
            model.removePhoto(photo.id)
        } label: {
            Label("Remove photo", systemImage: "trash")
        }
    }

    /// US-1909: an uncertain AI-proposed item — the seller confirms or discards.
    private func proposalReviewRow(_ review: ClientProposedGroup) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "questionmark.circle")
                .foregroundStyle(Color.brandNavy)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                Text("Group \(review.photoIds.count) photos as one item?")
                    .font(.subheadline.weight(.semibold))
                Text(review.reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("AI confidence \(Int((review.confidence * 100).rounded()))%")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Button("Group") {
                withAnimation { model.acceptProposalReview(review) }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .tint(Color.brandNavy)
            Button {
                withAnimation { model.dismissProposalReview(review) }
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .accessibilityLabel("Dismiss proposal")
        }
        .padding(12)
        .background(Color.brandNavy.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color.brandNavy.opacity(0.3))
        )
    }

    /// US-1548: one dismissible AI suggestion ("these two groups look like the
    /// same jacket — merge?") with Apply routed through the model's normal
    /// merge/split/move mutations.
    private func suggestionRow(_ suggestion: GroupVerifySuggestion) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "sparkles")
                .foregroundStyle(Color.orange)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                Text(suggestionTitle(suggestion))
                    .font(.subheadline.weight(.semibold))
                Text(suggestion.reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Button("Apply") {
                withAnimation { model.applySuggestion(suggestion) }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .tint(Color.brandNavy)
            Button {
                withAnimation { model.dismissSuggestion(suggestion) }
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .accessibilityLabel("Dismiss suggestion")
        }
        .padding(12)
        .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color.orange.opacity(0.35))
        )
    }

    private func suggestionTitle(_ suggestion: GroupVerifySuggestion) -> String {
        let names = suggestion.groupIds.compactMap { gid -> String? in
            guard let uuid = UUID(uuidString: gid),
                  let group = model.groups.first(where: { $0.id == uuid }) else {
                return nil
            }
            return "Item \(model.displayIndex(of: group))"
        }
        switch suggestion.type {
        case "merge":
            return "Merge \(names.joined(separator: " and "))?"
        case "split":
            return "Split \(suggestion.photoIds.count) photo\(suggestion.photoIds.count == 1 ? "" : "s") out of \(names.first ?? "this group")?"
        case "move":
            return "Move \(suggestion.photoIds.count) photo\(suggestion.photoIds.count == 1 ? "" : "s") from \(names.first ?? "one group") to \(names.last ?? "another")?"
        default:
            return "Review this grouping"
        }
    }

    private func groupCard(_ group: ReviewGroup) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Item \(model.displayIndex(of: group))")
                    .font(.brandHeadline)
                Spacer()
                Text("\(group.photoIds.count) photo\(group.photoIds.count == 1 ? "" : "s")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Menu {
                    Button(role: .destructive) {
                        pendingGroupDelete = group
                    } label: {
                        Label("Delete group", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .accessibilityLabel("Group options")
                }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(model.photos(in: group)) { photo in
                        thumbnail(photo, in: group)
                    }
                }
            }
        }
        .padding()
        .cardStyle(.flush)  // US-691: unified card chrome
    }

    private func thumbnail(_ photo: PhotoCapture, in group: ReviewGroup) -> some View {
        let isCover = photo.id == group.coverId
        return Image(uiImage: photo.thumbnail)
            .resizable()
            .scaledToFill()
            .frame(width: 92, height: 92)
            .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control))
            .overlay(alignment: .topLeading) {
                if isCover {
                    Label("Cover", systemImage: "star.fill")
                        .labelStyle(.titleAndIcon)
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 3)
                        .background(Color.brandNavy, in: Capsule())
                        .foregroundStyle(.white)
                        .padding(4)
                }
            }
            .overlay(
                RoundedRectangle(cornerRadius: CornerRadius.control)
                    .strokeBorder(isCover ? Color.brandNavy : .clear, lineWidth: 2)
            )
            .contextMenu { photoMenu(photo, in: group) }
            .accessibilityLabel(isCover ? "Cover photo" : "Photo")
            // US-1411: VoiceOver and Switch Control can't open a `.contextMenu`,
            // so the photo-management actions would be unreachable. Mirror them as
            // accessibility actions (the rotor "Actions" item).
            .accessibilityActions {
                if photo.id != group.coverId {
                    Button("Make cover") { model.setCover(photo.id, in: group.id) }
                }
                Button("Rotate right") { Task { await model.rotate(photo.id, clockwise: true) } }
                Button("Rotate left") { Task { await model.rotate(photo.id, clockwise: false) } }
                Button("Split to new group") { model.movePhoto(photo.id, from: group.id, to: nil) }
                ForEach(model.groups.filter { $0.id != group.id }) { other in
                    Button("Move to item \(model.displayIndex(of: other))") {
                        model.movePhoto(photo.id, from: group.id, to: other.id)
                    }
                }
                Button("Ungroup photo") { model.ungroupPhoto(photo.id, from: group.id) }
                Button("Remove photo") { model.removePhoto(photo.id) }
            }
    }

    @ViewBuilder
    private func photoMenu(_ photo: PhotoCapture, in group: ReviewGroup) -> some View {
        if photo.id != group.coverId {
            Button {
                model.setCover(photo.id, in: group.id)
            } label: {
                Label("Make cover", systemImage: "star")
            }
        }
        Button {
            Task { await model.rotate(photo.id, clockwise: true) }
        } label: {
            Label("Rotate right", systemImage: "rotate.right")
        }
        Button {
            Task { await model.rotate(photo.id, clockwise: false) }
        } label: {
            Label("Rotate left", systemImage: "rotate.left")
        }
        Button {
            model.movePhoto(photo.id, from: group.id, to: nil)
        } label: {
            Label("Split to new group", systemImage: "rectangle.split.2x1")
        }
        let others = model.groups.filter { $0.id != group.id }
        if !others.isEmpty {
            Menu("Move to…") {
                ForEach(others) { other in
                    Button("Item \(model.displayIndex(of: other))") {
                        model.movePhoto(photo.id, from: group.id, to: other.id)
                    }
                }
            }
        }
        // US-1909: park the photo in the ungrouped pool instead of guessing at a
        // home for it — the sort modes and "AI group" work over that pool.
        Button {
            model.ungroupPhoto(photo.id, from: group.id)
        } label: {
            Label("Ungroup photo", systemImage: "rectangle.badge.minus")
        }
        Divider()
        Button(role: .destructive) {
            model.removePhoto(photo.id)
        } label: {
            Label("Remove photo", systemImage: "trash")
        }
    }

    private var generateBar: some View {
        let count = model.groups.count
        return VStack(spacing: 8) {
            // Batch fill indicator — the seller sees how close they are to the
            // per-batch photo cap (uploads are serial, so the batch is bounded).
            HStack {
                Text("\(model.totalPhotos) of \(AutoListerReviewModel.maxBatchPhotos) photos")
                    .font(.caption)
                    .foregroundStyle(model.isAtCapacity ? Color.brandRed : .secondary)
                if model.isAtCapacity {
                    Text("· batch full")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Color.brandRed)
                }
                Spacer()
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(model.totalPhotos) of \(AutoListerReviewModel.maxBatchPhotos) photos in this batch\(model.isAtCapacity ? ", batch full" : "")")
            if !templateStore.templates.isEmpty {
                templatePicker
            }
            Button {
                HapticFeedback.medium()
                Telemetry.event(
                    "autolister_generate_started",
                    props: [
                        "groups": count,
                        "photos": model.totalPhotos,
                        "with_template": selectedTemplateId != nil,
                    ]
                )
                pendingGroups = model.preparedGroups()
            } label: {
                Text("Generate \(count) listing\(count == 1 ? "" : "s")")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(!model.canGenerate || uploadService == nil)
            .accessibilityHint("Creates an item per group, uploads its photos, and generates listings with AI.")
        }
        .padding()
        .background(.bar)
    }

    /// US-674: choose a listing template to apply to every generated draft.
    private var templatePicker: some View {
        Menu {
            Button {
                selectedTemplateId = nil
            } label: {
                if selectedTemplateId == nil {
                    Label("No template", systemImage: "checkmark")
                } else {
                    Text("No template")
                }
            }
            ForEach(templateStore.templates) { template in
                Button {
                    selectedTemplateId = template.id
                } label: {
                    if selectedTemplateId == template.id {
                        Label(template.name, systemImage: "checkmark")
                    } else {
                        Text(template.name)
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "doc.on.doc")
                Text(selectedTemplateLabel)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                Spacer()
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .padding(.horizontal, 12)
            .background(Color.brandNavy.opacity(0.1))
            .foregroundStyle(Color.brandNavy)
            .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
        }
        .accessibilityLabel("Listing template")
    }

    private var selectedTemplateLabel: String {
        guard let id = selectedTemplateId,
              let t = templateStore.templates.first(where: { $0.id == id })
        else { return "No template" }
        return "Template: \(t.name)"
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button {
                model.regroupAll()
                // US-1548: fresh groups → re-derive the AI suggestions.
                Task { await model.verifyGroupsNow() }
            } label: {
                Label("Auto-group", systemImage: "wand.and.stars")
            }
            .disabled(model.isEmpty)

            // US-1909: on-demand boundary verification now covers EVERY group
            // (the auto-run after import stays cheap at one window). A pass
            // needing more than one window confirms its AI-action cost first.
            Button {
                Task { await model.verifyAllGroups() }
            } label: {
                Label("Verify groups", systemImage: "checkmark.seal")
            }
            .disabled(model.groups.count < 2 || model.verifying)

            Button {
                presentPicker()
            } label: {
                Label("Add photos", systemImage: "plus")
            }
            .disabled(model.isAtCapacity)

            // US-675: jump to the persistent drafts library (review + bulk edit).
            NavigationLink {
                DraftsLibraryView()
            } label: {
                Label("Drafts", systemImage: "square.stack.3d.up")
            }
        }
    }
}
