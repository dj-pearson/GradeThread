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
                PhotoLibraryPicker(selectionLimit: 0) { results in
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
            retry: { await MainActor.run { showingPicker = true } }
        )
    }

    private var groupingErrorState: some View {
        ErrorStateView(
            title: "Couldn't group photos",
            message: "We couldn't sort your imported photos into items. Try grouping again, or import a fresh batch.",
            systemImage: "square.stack.3d.up.slash",
            retry: { await MainActor.run { model.regroupAll() } },
            secondaryTitle: "Import photos",
            secondaryAction: { showingPicker = true }
        )
    }

    // MARK: - Empty state

    /// US-656: standardized on ContentUnavailableView (like the rest of the app)
    /// instead of an ad-hoc VStack.
    private var emptyState: some View {
        ContentUnavailableView {
            Label("Batch-list with AutoLister", systemImage: "square.stack.3d.up.fill")
        } description: {
            Text("Import a batch of photos and we'll group them into items, then generate eBay listings with AI.")
        } actions: {
            Button {
                showingPicker = true
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
                // US-1548: AI grouping suggestions — advisory, one-tap apply,
                // never auto-applied. Silent when verification found nothing
                // (or failed); a small inline hint while it runs.
                if model.verifying {
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
                ForEach(model.groups) { group in
                    groupCard(group)
                }
            }
            .padding()
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) { generateBar }
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

            // US-1548: on-demand boundary verification (also auto-runs after
            // import). Costs one AI action; disabled mid-run or under 2 groups.
            Button {
                Task { await model.verifyGroupsNow() }
            } label: {
                Label("Verify groups", systemImage: "checkmark.seal")
            }
            .disabled(model.groups.count < 2 || model.verifying)

            Button {
                showingPicker = true
            } label: {
                Label("Add photos", systemImage: "plus")
            }

            // US-675: jump to the persistent drafts library (review + bulk edit).
            NavigationLink {
                DraftsLibraryView()
            } label: {
                Label("Drafts", systemImage: "square.stack.3d.up")
            }
        }
    }
}
