import SwiftUI

/// One editable eBay item-specific row, plus its provenance badge.
///
/// Extracted when the specifics moved from their own pushed screen onto the
/// item page (``ItemSpecificsInlineSections``), so the row rendering lives in
/// one place instead of being copied and left to drift.
///
/// Three shapes, keyed off the category spec (which mirrors what the web
/// composer does with the same payload):
///   * SELECTION_ONLY + multi  → a checkmark menu (closed list, many values)
///   * SELECTION_ONLY + single → a picker (closed list, one value)
///   * anything else with recommended values → free text WITH suggestions
///   * no values at all        → plain free text
struct AspectRowView: View {
    let model: SpecificsEditorModel
    let spec: AspectSpec

    var body: some View {
        if spec.selectionOnly, !spec.allowedValues.isEmpty {
            if spec.multiSelect {
                Menu {
                    ForEach(spec.allowedValues, id: \.self) { value in
                        Button {
                            model.toggleMulti(value, for: spec.name)
                        } label: {
                            Label(
                                value,
                                systemImage: model.isSelected(value, for: spec.name)
                                    ? "checkmark" : ""
                            )
                        }
                    }
                } label: {
                    LabeledContent {
                        Text(multiSummary).foregroundStyle(.secondary)
                    } label: {
                        AspectLabelView(model: model, spec: spec)
                    }
                }
            } else {
                Picker(
                    selection: Binding(
                        get: { model.firstValue(for: spec.name) },
                        set: { model.setSingle($0, for: spec.name) }
                    )
                ) {
                    Text("—").tag("")
                    ForEach(spec.allowedValues, id: \.self) { Text($0).tag($0) }
                } label: {
                    AspectLabelView(model: model, spec: spec)
                }
            }
        } else if !spec.allowedValues.isEmpty {
            // FREE_TEXT / SUGGESTED aspect that still ships recommended values —
            // Brand, Color, Material and Style are almost always this shape. Any
            // value is legal, but eBay's own list is offered as the seller types,
            // matching the web composer's datalist. Without this they hand-typed
            // "Black" in full on a field the API had already answered.
            VStack(alignment: .leading, spacing: 4) {
                AspectLabelView(model: model, spec: spec)
                AspectSuggestField(
                    placeholder: "Value",
                    suggestions: spec.allowedValues,
                    text: Binding(
                        get: { model.firstValue(for: spec.name) },
                        set: { model.setSingle($0, for: spec.name) }
                    )
                )
            }
        } else {
            LabeledContent {
                TextField(
                    "Value",
                    text: Binding(
                        get: { model.firstValue(for: spec.name) },
                        set: { model.setSingle($0, for: spec.name) }
                    )
                )
                .multilineTextAlignment(.trailing)
                .autocorrectionDisabled()
            } label: {
                AspectLabelView(model: model, spec: spec)
            }
        }
    }

    private var multiSummary: String {
        let selected = model.values[spec.name]?.filter { !$0.isEmpty } ?? []
        return selected.isEmpty ? "Select" : selected.joined(separator: ", ")
    }
}

/// US-825: aspect name + provenance badge (AI / Auto / You) when filled.
struct AspectLabelView: View {
    let model: SpecificsEditorModel
    let spec: AspectSpec

    var body: some View {
        HStack(spacing: 6) {
            Text(spec.name)
            if let prov = model.provenance(for: spec.name) {
                Text(prov.badgeLabel)
                    // US-1411: a Dynamic-Type style (scales) rather than a fixed
                    // 9pt that's below the legible floor and never grows.
                    .font(.caption2.weight(.medium))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(Self.badgeColor(prov).opacity(0.15), in: Capsule())
                    .foregroundStyle(Self.badgeColor(prov))
                    .accessibilityLabel(prov.badgeHint)
            }
        }
    }

    static func badgeColor(_ prov: AspectProvenance) -> Color {
        switch prov {
        case .aiExtracted: return Color.brandRed
        case .inventoryDerived: return Color.brandNavy
        case .manual: return .secondary
        }
    }
}
