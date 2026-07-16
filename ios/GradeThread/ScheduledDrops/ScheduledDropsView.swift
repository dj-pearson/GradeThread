import SwiftUI

/// Native Scheduled Drops (US-1127): parity with the web Scheduled Drops page.
/// List the draft listings queued to publish at a chosen (timezone-aware) time,
/// reschedule them to a peak-time preset or custom instant, and cancel them.
/// They publish automatically within ~5 minutes of their scheduled time.
struct ScheduledDropsView: View {
    @State private var store = ScheduledDropsStore()
    @State private var rescheduling: ScheduledDrop?
    // US-1160: confirm before cancelling a scheduled drop.
    @State private var pendingCancel: ScheduledDrop?
    // US-1266: persist the viewer's chosen display timezone across launches so
    // presets/times aren't reinterpreted in a different zone next session.
    @AppStorage("scheduledDrops.timeZone") private var persistedTimeZone = ""
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let currency = CurrencyFormatter()

    var body: some View {
        content
            .navigationTitle("Scheduled drops")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { timezoneMenu }
            }
            .task {
                if !persistedTimeZone.isEmpty { store.timeZoneIdentifier = persistedTimeZone }
                await store.load()
            }
            .onChange(of: store.timeZoneIdentifier) { _, newValue in
                persistedTimeZone = newValue
            }
            .refreshable { await store.load() }
            .sheet(item: $rescheduling) { drop in
                RescheduleSheet(drop: drop, store: store)
            }
            .overlay(alignment: .bottom) { bannerView }
            .task(id: store.actionBanner) {
                guard store.actionBanner != nil else { return }
                try? await Task.sleep(for: .seconds(2.5))
                withAnimation(ReducedMotion.animation(.default)) { store.actionBanner = nil }
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
            .confirmationDialog(
                "Cancel scheduled drop?",
                isPresented: Binding(
                    get: { pendingCancel != nil }, set: { if !$0 { pendingCancel = nil } }
                ),
                presenting: pendingCancel
            ) { drop in
                Button("Cancel drop", role: .destructive) {
                    pendingCancel = nil
                    Task { await store.cancel(drop) }
                }
                Button("Keep drop", role: .cancel) { pendingCancel = nil }
            } message: { _ in
                Text("This unschedules the drop. The item stays in your inventory.")
            }
    }

    @ViewBuilder
    private var content: some View {
        switch store.phase {
        case .loading:
            ScrollView { SkeletonRows(count: 5) }

        case .failed(let message):
            ErrorStateView(
                title: "Couldn't load scheduled drops",
                message: message,
                retry: { await store.load() }
            )

        case .ready:
            if store.isEmpty {
                ContentUnavailableView {
                    Label("No scheduled drops yet", systemImage: "calendar.badge.clock")
                } description: {
                    // US-1971: this control now actually exists on iOS. It used
                    // to point at a "Schedule publish" the composer never had —
                    // reachable only from the web — so the instruction was a
                    // dead end. Named the real path now that it isn't.
                    Text("Open an item, tap Publish to eBay, then turn on “Publish later” in the composer to pick a peak-time slot. Scheduled drafts appear here and publish automatically.")
                }
            } else {
                list
            }
        }
    }

    private var list: some View {
        List {
            Section {
                ForEach(store.drops) { drop in
                    DropRow(
                        drop: drop,
                        timeZoneIdentifier: store.timeZoneIdentifier,
                        currency: currency
                    )
                    .contentShape(Rectangle())
                    .onTapGesture { rescheduling = drop }
                    // US-1223: the row is tap-to-reschedule via a gesture, which
                    // carries no button semantics for VoiceOver. Expose it as a
                    // named action + button trait so the tap is discoverable; the
                    // swipe-to-cancel below stays exposed as its own action.
                    .accessibilityAddTraits(.isButton)
                    .accessibilityAction(named: Text("Reschedule")) { rescheduling = drop }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            pendingCancel = drop
                        } label: {
                            Label("Cancel", systemImage: "calendar.badge.minus")
                        }
                    }
                }
            } header: {
                Text("\(store.drops.count) scheduled")
            } footer: {
                Text("Drops publish automatically within ~5 minutes of their scheduled time. Tap a drop to reschedule, or swipe to cancel.")
            }
        }
    }

    private var timezoneMenu: some View {
        Menu {
            Picker("Timezone", selection: $store.timeZoneIdentifier) {
                ForEach(timezoneOptions, id: \.id) { tz in
                    Text(tz.label).tag(tz.id)
                }
            }
        } label: {
            Label("Timezone", systemImage: "globe")
        }
    }

    /// The curated list, with the detected zone merged in if it isn't present.
    private var timezoneOptions: [(id: String, label: String)] {
        let common = ScheduledDropScheduling.commonTimezones
        if common.contains(where: { $0.id == store.timeZoneIdentifier }) {
            return common
        }
        return [(store.timeZoneIdentifier, "\(store.timeZoneIdentifier) (your timezone)")] + common
    }

    @ViewBuilder
    private var bannerView: some View {
        if let banner = store.actionBanner {
            Text(banner)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 16).padding(.vertical, 10)
                .background(Color.brandNavy, in: Capsule())
                .padding(.bottom, 16)
                .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
        }
    }
}

// MARK: - Row

private struct DropRow: View {
    let drop: ScheduledDrop
    let timeZoneIdentifier: String
    let currency: CurrencyFormatter

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    if drop.isPromoted {
                        Image(systemName: "megaphone.fill")
                            .font(.caption2)
                            .foregroundStyle(Color.brandRed)
                            .accessibilityLabel("Promoted listing")
                    }
                    Text(drop.title)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)
                }
                Text(ScheduledDropScheduling.formatInZone(drop.scheduledPublishAt, timeZoneIdentifier: timeZoneIdentifier))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if drop.isPromoted, let rate = drop.promoRatePct {
                    Text("\(formattedRate(rate))% ad")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer(minLength: 0)
            // US-1196: an unpriced drop rendered a blank gap (formatDisplay(nil)
            // returns "") — show "No price" instead.
            if let price = drop.priceDollars {
                Text(currency.formatDisplay(price))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.brandNavy)
            } else {
                Text("No price")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private func formattedRate(_ rate: Double) -> String {
        rate == rate.rounded() ? String(Int(rate)) : String(format: "%.1f", rate)
    }
}

// MARK: - Reschedule sheet

private struct RescheduleSheet: View {
    let drop: ScheduledDrop
    let store: ScheduledDropsStore

    @Environment(\.dismiss) private var dismiss
    @State private var customDate: Date
    @State private var isSaving = false

    init(drop: ScheduledDrop, store: ScheduledDropsStore) {
        self.drop = drop
        self.store = store
        // US-1266: the drop's current time may already be in the past (an
        // un-fired drop whose time slipped by). The DatePicker's `in: Date()...`
        // bound doesn't re-validate a pre-set value, so seed it to the future to
        // avoid persisting (and immediately publishing) a past instant when the
        // user taps Reschedule without touching the picker.
        _customDate = State(initialValue: max(Date(), drop.scheduledPublishAt))
    }

    private var resolvedZone: TimeZone {
        TimeZone(identifier: store.timeZoneIdentifier) ?? .current
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(drop.title)
                        .font(.subheadline.weight(.semibold))
                    Text("Currently \(ScheduledDropScheduling.formatInZone(drop.scheduledPublishAt, timeZoneIdentifier: store.timeZoneIdentifier))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } header: {
                    Text("Drop")
                }

                Section {
                    ForEach(ScheduledDropScheduling.presets) { preset in
                        Button {
                            Task { await apply { await store.reschedule(drop, preset: preset) } }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(preset.label)
                                        .foregroundStyle(.primary)
                                    Text(preset.hint)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .disabled(isSaving)
                    }
                } header: {
                    Text("Peak-time presets")
                } footer: {
                    Text("Evaluated in \(store.timeZoneIdentifier).")
                }

                Section {
                    DatePicker(
                        "Custom time",
                        selection: $customDate,
                        // US-1196: constrain to the future so a past time can't be
                        // saved and then published almost immediately by the cron.
                        in: Date()...,
                        displayedComponents: [.date, .hourAndMinute]
                    )
                    .environment(\.timeZone, resolvedZone)
                    Button {
                        // US-1266: belt-and-suspenders — never send a past instant
                        // even if the bound value lagged the picker bound.
                        let when = max(customDate, Date())
                        Task { await apply { await store.reschedule(drop, to: when) } }
                    } label: {
                        if isSaving {
                            ProgressView()
                        } else {
                            Text("Reschedule")
                        }
                    }
                    .disabled(isSaving)
                } header: {
                    Text("Or pick a custom time")
                }
            }
            .navigationTitle("Reschedule drop")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }.disabled(isSaving)
                }
            }
        }
    }

    /// Run a reschedule action, then dismiss unless it surfaced an error.
    private func apply(_ action: () async -> Void) async {
        isSaving = true
        await action()
        isSaving = false
        if store.actionError == nil { dismiss() }
    }
}
