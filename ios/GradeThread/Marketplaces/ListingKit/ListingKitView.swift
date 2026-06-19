import SwiftUI
import UIKit

// US-745: the cross-marketplace Listing Kit. For an item that already has an
// eBay draft, it shows the server-generated per-platform fields (Poshmark,
// Mercari, Grailed, Depop) with native Copy / Copy-all / Share actions, a live
// char-count vs each platform's limit, the mapped condition + category, and the
// US-725 pre-flight validation — so a reseller can paste straight into the
// no-API marketplaces from their phone. eBay's publish path is untouched.

struct ListingKitView: View {
    @StateObject private var store: ListingKitStore
    /// The field key currently showing a transient "Copied" confirmation.
    @State private var copiedKey: String?

    init(itemId: String, itemTitle: String) {
        _store = StateObject(wrappedValue: ListingKitStore(itemId: itemId, itemTitle: itemTitle))
    }

    /// Test/preview seam: inject a pre-built store (e.g. with a fake service).
    init(store: ListingKitStore) {
        _store = StateObject(wrappedValue: store)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.md) {
                header
                content
            }
            .padding(Spacing.md)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("Listing Kit")
        .navigationBarTitleDisplayMode(.inline)
        .task { if store.phase == .idle { await store.load() } }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: Spacing.xxs) {
            Text(store.itemTitle)
                .font(.headline)
            Text("Copy these into Poshmark, Mercari, Grailed or Depop — fields are tailored per platform. Always double-check before you list.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .idle, .loading:
            VStack(spacing: Spacing.sm) {
                ProgressView()
                Text("Generating per-platform fields…")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, Spacing.xl)

        case .failed(let message):
            VStack(spacing: Spacing.sm) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.title2)
                    .foregroundStyle(Color.brandAmber)
                Text(message)
                    .font(.subheadline)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                Button("Try again") { Task { await store.load() } }
                    .buttonStyle(.brandSecondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, Spacing.lg)

        case .ready:
            if store.variants.isEmpty {
                Text("No cross-list fields were generated for this item.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ForEach(store.variants) { variant in
                    PlatformVariantCard(
                        variant: variant,
                        copiedKey: $copiedKey,
                        onCopy: copy
                    )
                }
            }
        }
    }

    /// Copy a value to the (non-sensitive) general pasteboard and flash a
    /// per-field "Copied" confirmation. Listing text isn't sensitive, so it uses
    /// the plain pasteboard rather than the expiring SecurePasteboard.
    private func copy(_ value: String, key: String) {
        UIPasteboard.general.string = value
        copiedKey = key
        Task {
            try? await Task.sleep(nanoseconds: 1_400_000_000)
            await MainActor.run { if copiedKey == key { copiedKey = nil } }
        }
    }
}

// MARK: - Per-platform card

private struct PlatformVariantCard: View {
    let variant: PlatformVariant
    @Binding var copiedKey: String?
    let onCopy: (_ value: String, _ key: String) -> Void

    private var platformLabel: String {
        if let label = variant.spec?.label { return label }
        return variant.platform.prefix(1).uppercased() + String(variant.platform.dropFirst())
    }

    /// Unique key namespace per platform so two platforms' "title" copies don't collide.
    private func fieldKey(_ key: String) -> String { "\(variant.platform).\(key)" }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            cardHeader
            mappingRow
            ForEach(variant.spec?.fields ?? []) { field in
                fieldRow(field)
            }
            footer
        }
        .padding(Spacing.md)
        .cardStyle(.flush)
    }

    private var cardHeader: some View {
        HStack {
            Text(platformLabel)
                .font(.subheadline.weight(.semibold))
            Spacer()
            validationBadge
        }
    }

    @ViewBuilder
    private var validationBadge: some View {
        let blockers = variant.blockingIssues.count
        let warnings = variant.warningIssues.count
        if blockers > 0 {
            badge("\(blockers) to fix", color: .brandRed)
        } else if warnings > 0 {
            badge("\(warnings) warning\(warnings == 1 ? "" : "s")", color: .brandAmber)
        } else {
            badge("Ready", color: .brandEmerald)
        }
    }

    private func badge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
    }

    /// Mapped condition + category (US-720/722), with the "pick a category" nudge.
    private var mappingRow: some View {
        VStack(alignment: .leading, spacing: Spacing.xxs) {
            if let condition = variant.condition {
                Label("Condition: \(condition.label)", systemImage: "checkmark.seal")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: Spacing.xxs) {
                Label("Category: \(variant.category.isEmpty ? "—" : variant.category)", systemImage: "folder")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if variant.categoryNeedsPick == true {
                    Text("verify")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Color.brandAmber)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func fieldRow(_ field: FieldSpec) -> some View {
        let value = variant.value(forField: field.key)
        let count = value.count
        let overLimit = (field.maxLength.map { count > $0 }) ?? false
        let key = fieldKey(field.key)
        VStack(alignment: .leading, spacing: Spacing.xxs) {
            HStack(alignment: .firstTextBaseline) {
                Text(field.label)
                    .font(.caption.weight(.semibold))
                if field.required {
                    Text("required")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if let limit = field.maxLength {
                    Text("\(count)/\(limit)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(overLimit ? Color.brandRed : .secondary)
                }
            }
            Text(value.isEmpty ? "—" : value)
                .font(.subheadline)
                .foregroundStyle(value.isEmpty ? .secondary : .primary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            // Inline validation issues for this field (block vs warn).
            ForEach(variant.issues(forField: field.key)) { issue in
                Label(issue.message, systemImage: issue.isError ? "xmark.octagon" : "exclamationmark.triangle")
                    .font(.caption2)
                    .foregroundStyle(issue.isError ? Color.brandRed : Color.brandAmber)
            }
            Button {
                onCopy(value, key)
            } label: {
                Label(copiedKey == key ? "Copied" : "Copy", systemImage: copiedKey == key ? "checkmark" : "doc.on.doc")
                    .font(.caption.weight(.medium))
            }
            .buttonStyle(.brandSecondary)
            .disabled(value.isEmpty)
        }
        .padding(.vertical, Spacing.xxs)
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(spacing: Spacing.sm) {
                Button {
                    onCopy(variant.copyAllText(), fieldKey("_all"))
                } label: {
                    Label(copiedKey == fieldKey("_all") ? "Copied all" : "Copy all", systemImage: "doc.on.doc.fill")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.brandPrimary)

                ShareLink(item: variant.copyAllText()) {
                    Label("Share", systemImage: "square.and.arrow.up")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.brandSecondary)
            }
            if let note = variant.spec?.sourceNote, !note.isEmpty {
                Text(note)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.top, Spacing.xxs)
    }
}
