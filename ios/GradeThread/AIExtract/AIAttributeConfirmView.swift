import SwiftUI

/// US-826: one-tap confirm chips for the high-value attributes eBay almost
/// always requires but AI can only infer — Department, Size Type, Vintage, and a
/// condition tier. Each row is pre-selected from the AI's guess (US-821
/// `attributes`) and writable in a single tap. Confirming hands the user's
/// choices back to ``AIExtractView`` which persists them to
/// `inventory_items.attributes` with `ai_field_sources` provenance.
struct AIAttributeConfirmView: View {
    /// AI-suggested values keyed by canonical attribute name (department, …).
    let suggestions: [String: AttributeSuggestion]
    /// Called with the user's final decision per field when they confirm.
    let onConfirm: ([AIAttributeConfirm.Result]) -> Void
    /// Called when the user skips — every AI-suggested field is recorded
    /// `accepted = false`.
    let onSkip: () -> Void

    /// canonical key → selected option (absent ⇒ unselected).
    @State private var selections: [String: String] = [:]
    @State private var didInitialize = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    header
                    ForEach(AIAttributeConfirm.fields) { field in
                        fieldRow(field)
                    }
                }
                .padding(20)
            }
            footer
        }
        .background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
        .onAppear(perform: initializeSelectionsIfNeeded)
    }

    // MARK: - Sections

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Confirm key details")
                .font(.brandHeadline)
            Text("eBay almost always needs these. We pre-filled the AI's best guess — tap to change.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func fieldRow(_ field: AIAttributeConfirm.Field) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text(field.label)
                    .font(.subheadline.weight(.semibold))
                if isAISuggested(field) {
                    Text("AI")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(Color.brandNavy)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(Color.brandNavy.opacity(0.12))
                        .clipShape(Capsule())
                }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(field.options, id: \.self) { option in
                        chip(field: field, option: option)
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }

    private func chip(field: AIAttributeConfirm.Field, option: String) -> some View {
        let isSelected = selections[field.key] == option
        return Button {
            // Tapping the selected chip clears it (so a wrong AI guess can be
            // rejected outright); tapping another selects it.
            if isSelected {
                selections[field.key] = nil
            } else {
                selections[field.key] = option
            }
        } label: {
            Text(option)
                .font(.subheadline.weight(.medium))
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(isSelected ? Color.brandNavy : Color(uiColor: .secondarySystemBackground))
                .foregroundStyle(isSelected ? Color.white : Color.primary)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(field.label): \(option)")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var footer: some View {
        VStack(spacing: 10) {
            Button(action: confirm) {
                Text("Confirm")
                    .font(.headline)
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(Color.brandNavy)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            Button(action: onSkip) {
                Text("Skip")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(20)
        .background(.ultraThinMaterial)
    }

    // MARK: - Logic

    private func isAISuggested(_ field: AIAttributeConfirm.Field) -> Bool {
        guard let first = suggestions[field.key]?.values.first else { return false }
        return !first.isEmpty
    }

    /// Pre-select each field from the AI's guess, matched case-insensitively to
    /// a known option so the server's persisted value lights up the right chip.
    private func initializeSelectionsIfNeeded() {
        guard !didInitialize else { return }
        didInitialize = true
        for field in AIAttributeConfirm.fields {
            guard let suggested = suggestions[field.key]?.values.first, !suggested.isEmpty else { continue }
            if let match = field.options.first(where: { $0.caseInsensitiveCompare(suggested) == .orderedSame }) {
                selections[field.key] = match
            }
        }
    }

    private func confirm() {
        var results: [AIAttributeConfirm.Result] = []
        for field in AIAttributeConfirm.fields {
            let suggestion = suggestions[field.key]
            let suggestedValue = suggestion?.values.first
            if let picked = selections[field.key] {
                // Kept the AI value ⇒ carry its provenance; changed/added ⇒ manual.
                let keptAI = suggestedValue?.caseInsensitiveCompare(picked) == .orderedSame
                results.append(AIAttributeConfirm.Result(
                    key: field.key,
                    value: picked,
                    source: keptAI ? (suggestion?.source ?? "manual") : "manual",
                    confidence: keptAI ? (suggestion?.confidence ?? 1.0) : 1.0
                ))
            } else if suggestion != nil {
                // AI suggested but the user cleared it ⇒ explicit reject.
                results.append(AIAttributeConfirm.Result(
                    key: field.key,
                    value: nil,
                    source: suggestion?.source ?? "ai",
                    confidence: suggestion?.confidence ?? 0
                ))
            }
            // No suggestion and no pick ⇒ nothing to record.
        }
        onConfirm(results)
    }
}
