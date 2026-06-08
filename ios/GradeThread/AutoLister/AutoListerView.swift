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
        } else if model.isEmpty {
            emptyState
        } else {
            reviewList
        }
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
                ForEach(model.groups) { group in
                    groupCard(group)
                }
            }
            .padding()
        }
        .safeAreaInset(edge: .bottom) { generateBar }
    }

    private func groupCard(_ group: ReviewGroup) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Item \(model.displayIndex(of: group))")
                    .font(.headline)
                Spacer()
                Text("\(group.photoIds.count) photo\(group.photoIds.count == 1 ? "" : "s")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Menu {
                    Button(role: .destructive) {
                        model.deleteGroup(group.id)
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
        .background(
            RoundedRectangle(cornerRadius: 14)
                .fill(Color(.secondarySystemGroupedBackground))
        )
    }

    private func thumbnail(_ photo: PhotoCapture, in group: ReviewGroup) -> some View {
        let isCover = photo.id == group.coverId
        return Image(uiImage: photo.thumbnail)
            .resizable()
            .scaledToFill()
            .frame(width: 92, height: 92)
            .clipShape(RoundedRectangle(cornerRadius: 10))
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
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(isCover ? Color.brandNavy : .clear, lineWidth: 2)
            )
            .contextMenu { photoMenu(photo, in: group) }
            .accessibilityLabel(isCover ? "Cover photo" : "Photo")
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
            } label: {
                Label("Auto-group", systemImage: "wand.and.stars")
            }
            .disabled(model.isEmpty)

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
