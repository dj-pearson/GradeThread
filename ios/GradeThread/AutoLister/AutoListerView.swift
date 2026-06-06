import PhotosUI
import SwiftUI
import UIKit

/// AutoLister capture + review screen. Import a batch of library photos, review
/// the auto-derived item groups (set cover, split, merge, delete), then Generate.
///
/// The Generate action is injected (`onGenerate`) so this screen stays
/// self-contained; Phase C wires it to the create-items → upload → classify →
/// submit pipeline and pushes the queue.
struct AutoListerView: View {
    @StateObject private var model = AutoListerReviewModel()
    @State private var showingPicker = false

    /// Called with the reviewed groups when the user taps Generate. Default is a
    /// no-op so the view compiles + previews standalone before the pipeline lands.
    var onGenerate: ([PreparedGroup]) async -> Void = { _ in }

    var body: some View {
        content
            .navigationTitle("AutoLister")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbarContent }
            .sheet(isPresented: $showingPicker) {
                PhotoLibraryPicker(selectionLimit: 0) { results in
                    showingPicker = false
                    Task { await model.importPicks(results) }
                }
                .ignoresSafeArea()
            }
    }

    @ViewBuilder
    private var content: some View {
        if model.isImporting && model.isEmpty {
            ProgressView("Importing photos…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if model.isEmpty {
            emptyState
        } else {
            reviewList
        }
    }

    // MARK: - Empty state

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "square.stack.3d.up.fill")
                .font(.system(size: 48, weight: .light))
                .foregroundStyle(Color.brandNavy)
            Text("Batch-list with AutoLister")
                .font(.title3.weight(.semibold))
            Text("Import a batch of photos and we'll group them into items, then generate eBay listings with AI.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button {
                showingPicker = true
            } label: {
                Label("Import photos", systemImage: "photo.on.rectangle.angled")
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .padding(.top, 4)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
        return Button {
            Task { await onGenerate(model.preparedGroups()) }
        } label: {
            Text("Generate \(count) listing\(count == 1 ? "" : "s")")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(!model.canGenerate)
        .padding()
        .background(.bar)
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
        }
    }
}
