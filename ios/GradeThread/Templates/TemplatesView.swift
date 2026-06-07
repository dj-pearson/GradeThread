import SwiftUI

/// Manage listing templates (US-674): create, edit, set a default, and delete
/// reusable presets. Reachable from Settings → Data. Templates are then
/// selectable in the Publish composer and the AutoLister flow.
struct TemplatesView: View {
    @State private var store = TemplateStore()
    @State private var editing: EditorTarget?

    var body: some View {
        content
            .navigationTitle("Listing templates")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        editing = .new
                    } label: {
                        Image(systemName: "plus")
                            .accessibilityLabel("New template")
                    }
                }
            }
            .task { await store.load() }
            .refreshable { await store.load() }
            .sheet(item: $editing) { target in
                TemplateEditorSheet(
                    existing: target.template,
                    store: store
                )
            }
            .alert(
                "Something went wrong",
                isPresented: Binding(
                    get: { store.actionError != nil },
                    set: { if !$0 { store.actionError = nil } }
                ),
                presenting: store.actionError
            ) { _ in
                Button("OK", role: .cancel) { store.actionError = nil }
            } message: { Text($0) }
    }

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .loading:
            ScrollView { SkeletonRows(count: 4) }

        case .failed(let message):
            ContentUnavailableView {
                Label("Couldn't load templates", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") { Task { await store.load() } }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.brandNavy)
            }

        case .ready where store.isEmpty:
            ContentUnavailableView {
                Label("No templates yet", systemImage: "doc.on.doc")
            } description: {
                Text("Save a reusable preset — description boilerplate, item specifics, condition, and policies — to apply it in one tap when listing.")
            } actions: {
                Button("New template") { editing = .new }
                    .buttonStyle(.borderedProminent)
                    .tint(Color.brandNavy)
            }

        case .ready:
            list
        }
    }

    private var list: some View {
        List {
            ForEach(store.templates) { template in
                Button {
                    editing = .edit(template)
                } label: {
                    TemplateRow(template: template)
                }
                .buttonStyle(.plain)
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        Task { await store.delete(template) }
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                }
            }
        }
    }
}

private struct TemplateRow: View {
    let template: ListingTemplate

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(template.name)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                if template.isDefault {
                    Text("Default")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.brandNavy.opacity(0.12))
                        .foregroundStyle(Color.brandNavy)
                        .clipShape(Capsule())
                }
            }
            if let summary = summary {
                Text(summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    private var summary: String? {
        var parts: [String] = []
        if let c = template.ebayCondition { parts.append(EbayCondition.resolve(c).label) }
        if template.descriptionTemplate?.isEmpty == false { parts.append("boilerplate") }
        if !template.itemSpecifics.isEmpty {
            parts.append("\(template.itemSpecifics.count) specific\(template.itemSpecifics.count == 1 ? "" : "s")")
        }
        if template.shippingPolicyId != nil || template.returnPolicyId != nil || template.paymentPolicyId != nil {
            parts.append("policies")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// Identifies whether the editor is creating a new template or editing one.
private enum EditorTarget: Identifiable {
    case new
    case edit(ListingTemplate)

    var id: String {
        switch self {
        case .new: return "new"
        case .edit(let t): return t.id
        }
    }

    var template: ListingTemplate? {
        switch self {
        case .new: return nil
        case .edit(let t): return t
        }
    }
}
