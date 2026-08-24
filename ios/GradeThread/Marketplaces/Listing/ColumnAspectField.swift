import SwiftUI

/// One of the item's OWN inputs (Brand / Size / Color / Material / Style),
/// rendered from eBay's spec for the chosen category instead of as a bare
/// text field.
///
/// Why this exists (US-2839). Those five are the fields a seller touches on
/// every single item, and they were the only ones on the item page that never
/// offered eBay's values. The specifics section below them hides those aspects
/// on purpose — one value, one input — so hiding the row hid its dropdown with
/// it, and "Style" on a jacket was a blank box the seller had to guess into
/// while the web composer showed Basic / Cropped / Jersey / Pullover / Ringer
/// from the very same payload.
///
/// The shapes match ``AspectRowView`` and the web composer's aspect field:
///   * SELECTION_ONLY      → a picker over eBay's closed list
///   * values, free text   → text field WITH eBay's values as suggestions
///   * no spec / no values → the plain text field this replaced
///
/// The binding is still the item COLUMN, not the aspect map — the column is the
/// write-authority (the edge force-projects it onto the aspect at publish), so
/// nothing about saving, syncing or provenance changes. Only the input changes.
struct ColumnAspectField: View {
    /// nil until the specifics editor has loaded, and while the item has no
    /// eBay category. Renders as plain text then, so the field is never missing
    /// or disabled while the spec is in flight.
    let model: SpecificsEditorModel?
    /// The item column: "brand" / "size" / "color" / "material" / "style".
    let column: String
    /// The field's own label, unchanged from the plain text field it replaced.
    let label: String
    @Binding var text: String
    var capitalization: TextInputAutocapitalization = .words

    private var spec: AspectSpec? { model?.columnSpec(for: column) }

    var body: some View {
        if let spec, spec.selectionOnly, !spec.allowedValues.isEmpty {
            Picker(label, selection: selection(spec)) {
                Text("—").tag("")
                ForEach(Self.options(for: spec, current: text), id: \.self) { value in
                    Text(Self.optionLabel(value, in: spec)).tag(value)
                }
            }
        } else if let spec, !spec.allowedValues.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(label)
                AspectSuggestField(
                    placeholder: label,
                    suggestions: spec.allowedValues,
                    text: $text
                )
            }
        } else {
            TextField(label, text: $text)
                .textInputAutocapitalization(capitalization)
                .autocorrectionDisabled()
        }
    }

    /// The picker reads eBay's spelling and writes the seller's pick straight
    /// through to the column.
    ///
    /// A SwiftUI picker shows NO selection when the bound value matches no
    /// option's tag, and "Black" from eBay is not "black" from a CSV import — so
    /// a case-only difference would render as an empty field over a value that
    /// is perfectly good, and the next save would write the blank back. Reading
    /// through ``canonical`` keeps the row on eBay's spelling of what the column
    /// already holds.
    private func selection(_ spec: AspectSpec) -> Binding<String> {
        Binding(get: { Self.canonical(text, in: spec) }, set: { text = $0 })
    }

    // MARK: - Pure helpers (unit-tested)

    /// eBay's spelling of a value the column holds, or the value untouched when
    /// this category's list has no match for it.
    static func canonical(_ value: String, in spec: AspectSpec) -> String {
        let wanted = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !wanted.isEmpty else { return "" }
        return spec.allowedValues.first { $0.lowercased() == wanted } ?? value
    }

    /// eBay's list, plus whatever the column already holds when that is not on
    /// it.
    ///
    /// An off-list value — AI-filled, imported, or set before the category was
    /// picked — has no option to select, so the picker would render blank and
    /// the value would be gone the moment the seller saved. Carrying it as an
    /// extra option keeps it visible and keeps it selected. It is still not sent
    /// to eBay: the publish path drops closed-list values that do not match (see
    /// aspect-reconcile's omitted diagnostics). That is also why there is no
    /// "type your own" here — it would be an input that silently goes nowhere.
    static func options(for spec: AspectSpec, current: String) -> [String] {
        let trimmed = current.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return spec.allowedValues }
        let known = spec.allowedValues.contains { $0.lowercased() == trimmed.lowercased() }
        return known ? spec.allowedValues : spec.allowedValues + [current]
    }

    /// Off-list values are labelled, so the seller can tell the one eBay will
    /// not take from the ones it will.
    static func optionLabel(_ value: String, in spec: AspectSpec) -> String {
        let wanted = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let known = spec.allowedValues.contains { $0.lowercased() == wanted }
        return known ? value : "\(value) (not an eBay value)"
    }
}
