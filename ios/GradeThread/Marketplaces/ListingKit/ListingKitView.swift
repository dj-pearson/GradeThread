import SwiftUI
import UIKit

// US-745: the cross-marketplace Listing Kit. For an item that already has an
// eBay draft, it shows the server-generated per-platform fields (Poshmark,
// Mercari, Grailed, Depop) with native Copy / Copy-all / Share actions, a live
// char-count vs each platform's limit, the mapped condition + category, and the
// US-725 pre-flight validation — so a reseller can paste straight into the
// no-API marketplaces from their phone. eBay's publish path is untouched.

struct ListingKitView: View {
    // US-1180: @Observable store via @State (was @StateObject/ObservableObject).
    @State private var store: ListingKitStore
    /// The field key currently showing a transient "Copied" confirmation.
    @State private var copiedKey: String?
    /// US-3103: the push-to picker.
    @State private var showingPushTo = false

    init(itemId: String, itemTitle: String) {
        _store = State(initialValue: ListingKitStore(itemId: itemId, itemTitle: itemTitle))
    }

    /// Test/preview seam: inject a pre-built store (e.g. with a fake service).
    init(store: ListingKitStore) {
        _store = State(initialValue: store)
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
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingPushTo = true
                } label: {
                    Label(String(localized: "Push to"), systemImage: "paperplane")
                }
                // The route addresses a LISTING; with no draft there is nothing
                // to push, and offering the button would open a sheet that can
                // only fail.
                .disabled(store.listingId == nil)
            }
        }
        .task { if store.phase == .idle { await store.load() } }
        .sheet(isPresented: $showingPushTo) {
            if let listingId = store.listingId {
                PushToSheet(
                    listingId: listingId,
                    itemId: store.itemId,
                    listingPrice: store.variants.first?.price
                )
            }
        }
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
                        onCopy: copy,
                        itemId: store.itemId
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
        // US-1193: copy is the kit's whole purpose — confirm it for non-sighted
        // users (the "Copied" label swap is invisible to VoiceOver) and add a
        // tactile confirmation.
        HapticFeedback.success()
        A11yAnnounce.announce("Copied")
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
    /// US-2481: the item this card belongs to, so the queue row can name it.
    let itemId: String

    /// US-2481: queueing state for this card's "Run on my desktop" button.
    @State private var queueState: QueueState = .idle

    private enum QueueState: Equatable {
        case idle
        case sending
        case queued
        case failed(String)
    }

    /// Channels the desktop extension can actually run.
    ///
    /// Mirrors `LISTER_EXTENSION_PLATFORMS` in src/lib/lister-extension.ts. Depop
    /// is deliberately absent: it has a real partner API, so a seller never needs
    /// their browser for it and offering the queue there would be a worse path
    /// than the one that already exists.
    private static let queueablePlatforms: Set<String> = [
        "poshmark", "mercari", "grailed", "vinted", "facebook",
    ]

    private var isQueueable: Bool {
        Self.queueablePlatforms.contains(variant.platform)
    }

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
            // US-2534: the visible word is "Copy" on every field, so VoiceOver
            // read "Copy, Copy, Copy" down the screen with nothing to tell them
            // apart. Naming the field is the whole fix — and note this is
            // invisible to an audit that counts whether a label EXISTS, because
            // every one of these already had one. Same shape as US-2450.
            .accessibilityLabel(copiedKey == key ? "Copied \(field.label)" : "Copy \(field.label)")
        }
        .padding(.vertical, Spacing.xxs)
    }

    private var footer: some View {
        // US-1522: compute once and disable Copy all / Share when there's nothing
        // to copy — otherwise "Copy all" copies an empty string while flashing
        // "Copied all", and Share shares an empty payload.
        let allText = variant.copyAllText()
        let isEmpty = allText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return VStack(alignment: .leading, spacing: Spacing.xs) {
            HStack(spacing: Spacing.sm) {
                Button {
                    onCopy(allText, fieldKey("_all"))
                } label: {
                    Label(copiedKey == fieldKey("_all") ? "Copied all" : "Copy all", systemImage: "doc.on.doc.fill")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.brandPrimary)
                .disabled(isEmpty)

                ShareLink(item: allText) {
                    Label("Share", systemImage: "square.and.arrow.up")
                        .font(.caption.weight(.semibold))
                }
                .buttonStyle(.brandSecondary)
                .disabled(isEmpty)
            }

            // US-2481: the actual point of the queue.
            //
            // Copy-and-paste is what a seller does when they are AT a desktop.
            // This is the other case — sourcing in a shop with a phone — and
            // without a control here the queue is a table nothing ever writes to.
            if isQueueable {
                queueRow
            }
            if let note = variant.spec?.sourceNote, !note.isEmpty {
                Text(note)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.top, Spacing.xxs)
    }

    /// US-2481: queue this platform's listing for the desktop extension.
    ///
    /// The success copy is the part that matters. It says the work is WAITING,
    /// never that it is done — `ExtensionQueueService.queuedNotice` is shared
    /// verbatim with web, Android and the edge for exactly that reason. A seller
    /// told "Listed!" for a queued job believes their item is live when it is
    /// not, and for a delist that belief is what becomes a double sale.
    @ViewBuilder
    private var queueRow: some View {
        VStack(alignment: .leading, spacing: Spacing.xxs) {
            Button {
                Task { await queueForDesktop() }
            } label: {
                Label(
                    queueState == .queued ? "Waiting for your desktop" : "Run on my desktop",
                    systemImage: queueState == .queued ? "checkmark.circle" : "desktopcomputer"
                )
                .font(.caption.weight(.semibold))
            }
            .buttonStyle(.brandSecondary)
            .disabled(queueState == .sending || queueState == .queued)

            switch queueState {
            case .queued:
                Text(ExtensionQueueService.queuedNotice)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            case .failed(let message):
                Text(message)
                    .font(.caption2)
                    .foregroundStyle(Color.brandRed)
            case .idle, .sending:
                EmptyView()
            }
        }
        .padding(.top, Spacing.xxs)
    }

    private func queueForDesktop() async {
        queueState = .sending
        do {
            _ = try await ExtensionQueueService.shared.enqueue(
                kind: .list,
                platform: variant.platform,
                inventoryItemId: itemId
            )
            queueState = .queued
        } catch {
            // Surfaced rather than swallowed: a seller who thinks they queued
            // something and did not will stand in a shop waiting for a job that
            // does not exist.
            queueState = .failed("Couldn't queue that. Try again when you have signal.")
        }
    }
}
