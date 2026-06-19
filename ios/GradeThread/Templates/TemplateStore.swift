import Foundation
import Observation

/// Loads + mutates the workspace's listing templates (US-674). Mirrors the
/// phase + optimistic-action shape of the other FlipDesk stores. Shared by the
/// Settings manager, the Publish composer, and the AutoLister picker.
@MainActor
@Observable
final class TemplateStore {
    enum Phase: Equatable {
        case loading
        case ready
        case failed(message: String)
    }

    private let service: TemplateProviding

    var phase: Phase = .loading
    private(set) var templates: [ListingTemplate] = []
    /// Surfaced when a create/update/delete fails; the view shows it in an alert.
    var actionError: String?
    /// Brief success confirmation (e.g. "Template saved."); the view shows it in
    /// a transient toast so a successful save isn't silent after the editor closes.
    var actionBanner: String?

    init(service: TemplateProviding = TemplateService()) {
        self.service = service
    }

    /// The seller's pre-selected go-to template, if any.
    var defaultTemplate: ListingTemplate? { templates.first { $0.isDefault } }

    var isEmpty: Bool { templates.isEmpty }

    func load() async {
        phase = .loading
        do {
            templates = sorted(try await service.list())
            phase = .ready
        } catch {
            phase = .failed(message: error.localizedDescription)
        }
    }

    /// Create (when `editingId` is nil) or replace a template. Returns true on
    /// success so the editor can dismiss; surfaces the error otherwise.
    @discardableResult
    func save(_ draft: TemplateDraft, editingId: String?) async -> Bool {
        do {
            let saved: ListingTemplate
            if let editingId {
                saved = try await service.update(id: editingId, draft)
            } else {
                saved = try await service.create(draft)
            }
            upsert(saved)
            actionBanner = editingId == nil ? "Template saved." : "Template updated."
            HapticFeedback.success()
            return true
        } catch {
            actionError = error.localizedDescription
            HapticFeedback.error()
            return false
        }
    }

    /// Optimistically removes, then deletes server-side; reloads on failure.
    func delete(_ template: ListingTemplate) async {
        templates.removeAll { $0.id == template.id }
        do {
            try await service.delete(id: template.id)
        } catch {
            actionError = error.localizedDescription
            await load()
        }
    }

    // MARK: - Private

    private func upsert(_ t: ListingTemplate) {
        if let i = templates.firstIndex(where: { $0.id == t.id }) {
            templates[i] = t
        } else {
            templates.append(t)
        }
        // The server enforces a single default; mirror that locally so the UI
        // doesn't briefly show two defaults before the next reload.
        if t.isDefault {
            for i in templates.indices where templates[i].id != t.id {
                templates[i].isDefault = false
            }
        }
        templates = sorted(templates)
    }

    private func sorted(_ list: [ListingTemplate]) -> [ListingTemplate] {
        list.sorted {
            ($0.sortOrder, $0.name.lowercased()) < ($1.sortOrder, $1.name.lowercased())
        }
    }
}
