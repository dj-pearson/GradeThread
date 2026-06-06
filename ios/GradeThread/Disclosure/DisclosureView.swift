import SwiftUI
import UIKit

/// Defect Disclosure screen (presented as a sheet from the certified-grade
/// section). Shows each defect photo composited with numbered callout boxes +
/// legend, with actions to save the annotated image to the listing photos and
/// to append the disclosure text to the listing description.
struct DisclosureView: View {
    @State private var store: DisclosureStore
    @Environment(\.dismiss) private var dismiss

    init(itemId: String) {
        _store = State(initialValue: DisclosureStore(itemId: itemId))
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Defect disclosure")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { dismiss() }
                    }
                }
                .task { if store.phase == .idle { await store.load() } }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .idle, .loading:
            ProgressView("Loading disclosure…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let message):
            ContentUnavailableView {
                Label("Couldn't load disclosure", systemImage: "wifi.exclamationmark")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") { Task { await store.load() } }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.brandNavy)
            }
        case .loaded:
            if store.defectPhotos.isEmpty {
                ContentUnavailableView(
                    "No defects to disclose",
                    systemImage: "checkmark.seal",
                    description: Text("This grade didn't flag any defects worth disclosing.")
                )
            } else {
                listContent
            }
        }
    }

    private var listContent: some View {
        List {
            ForEach(store.defectPhotos) { photo in
                Section {
                    photoRow(photo)
                    saveButton(photo)
                } header: {
                    Text(photo.imageType.capitalized)
                }
            }
            if let plain = store.plainDisclosure {
                Section("Condition disclosure") {
                    Text(plain).font(.subheadline).foregroundStyle(.secondary)
                    applyTextButton
                }
            }
            if let message = store.errorMessage {
                Section {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(Color.brandRed)
                }
            }
        }
    }

    @ViewBuilder
    private func photoRow(_ photo: DisclosurePhoto) -> some View {
        if let image = store.rendered[photo.id] {
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .accessibilityLabel("Annotated \(photo.imageType) photo, \(photo.annotations.count) flagged defects")
        } else {
            HStack { Spacer(); ProgressView(); Spacer() }
                .frame(minHeight: 120)
        }
    }

    @ViewBuilder
    private func saveButton(_ photo: DisclosurePhoto) -> some View {
        Button {
            Task { await store.save(photo) }
        } label: {
            if store.isSaving(photo) {
                HStack { ProgressView(); Text("Saving…") }
            } else {
                Label(
                    store.isSaved(photo) ? "Saved to listing photos" : "Save to listing photos",
                    systemImage: store.isSaved(photo) ? "checkmark.circle.fill" : "square.and.arrow.down"
                )
            }
        }
        .disabled(store.isSaving(photo) || store.isSaved(photo) || store.rendered[photo.id] == nil)
    }

    @ViewBuilder
    private var applyTextButton: some View {
        Button {
            Task { await store.applyText() }
        } label: {
            if store.isApplyingText {
                HStack { ProgressView(); Text("Adding…") }
            } else {
                Label(
                    store.appliedText ? "Added to listing description" : "Add to listing description",
                    systemImage: store.appliedText ? "checkmark.circle.fill" : "text.badge.plus"
                )
            }
        }
        .disabled(store.isApplyingText || store.appliedText)
    }
}
