import SwiftData
import SwiftUI

/// US-3014 — logging a trip, in the time it takes to walk to the car.
///
/// The whole feature is a race against the seller's patience. A form that takes
/// longer than the drive is a form nobody fills in, and an unlogged trip is a
/// deduction that quietly does not get claimed. So: miles and purpose are the
/// only required fields, the date defaults to today, and everything else is
/// optional and below the fold.
struct TripFormSheet: View {
    let store: MileageStore
    /// Pre-attributes the drive to a sourcing trip when opened from one.
    var presetSourceId: String?
    /// Pre-fills a purpose. Scout opens this with `sourcing` already chosen.
    var presetPurpose: String = TripDraft.defaultPurpose

    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    @Environment(AuthStore.self) private var authStore
    @Environment(NetworkMonitor.self) private var networkMonitor: NetworkMonitor?

    @State private var draft = TripDraft.today()
    @State private var customPurpose = ""
    @State private var usingCustomPurpose = false
    @State private var isSaving = false
    @State private var errorMessage: String?

    // US-3220: a swipe-down used to bin a half-logged trip with no warning.
    @State private var showingDiscard = false
    /// The draft as `onAppear` left it (presets applied, nothing typed). Set
    /// there rather than in the initializer because the presets land there.
    @State private var pristine: TripDraft?

    /// True once the seller has changed anything from the pre-filled form.
    private var isDirty: Bool {
        guard let pristine else { return false }
        return draft != pristine || !customPurpose.isEmpty || usingCustomPurpose
    }

    /// The purpose actually saved: the picker's wire value, or what the seller
    /// typed. The column is free text on the server precisely so the IRS's "in
    /// your own words" answer is possible.
    private var resolvedPurpose: String {
        usingCustomPurpose ? customPurpose : draft.purpose
    }

    private var pending: TripDraft {
        var copy = draft
        copy.purpose = resolvedPurpose
        return copy
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        TextField("Miles", text: $draft.milesText)
                            .keyboardType(.decimalPad)
                        Text("miles")
                            .foregroundStyle(.secondary)
                    }
                    // Says WHY Save is off rather than leaving a dead button,
                    // the same way the expense form does.
                    if let reason = pending.invalidReason, !draft.milesText.isEmpty {
                        Text(reason.message)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    // US-3230: the picker reads local midnight and writes back
                    // the UTC-anchored day, so the day on screen is the day on
                    // the wire in every zone.
                    DatePicker(
                        "Date",
                        selection: MoneyDate.dayPicker($draft.tripDate),
                        displayedComponents: .date
                    )
                } footer: {
                    Text("Log it the day you drive it. A log written up weeks later is the kind the IRS discounts.")
                        .font(.footnote)
                }

                Section("What for") {
                    Picker("Purpose", selection: $draft.purpose) {
                        ForEach(TripDraft.purposes, id: \.wire) { purpose in
                            Text(purpose.label).tag(purpose.wire)
                        }
                    }
                    Toggle("Type my own", isOn: $usingCustomPurpose)
                    if usingCustomPurpose {
                        TextField("What was the trip for?", text: $customPurpose)
                    }
                }

                Section {
                    TextField("From (optional)", text: $draft.startLocation)
                    TextField("To (optional)", text: $draft.endLocation)
                    Toggle("Round trip", isOn: $draft.roundTrip)
                } header: {
                    // Spelled out as a view, not Section("Where"): there is no
                    // initializer taking a String title alongside a footer.
                    Text("Where")
                } footer: {
                    Text("Round trip is a note on the record, not a doubling. Enter the total miles you actually drove.")
                        .font(.footnote)
                }

                if NetworkMonitor.isOffline(networkMonitor) {
                    Section {
                        OfflineNotice(intent: .queued)
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                    }
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
            }
            .keyboardDoneToolbar()
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Log a trip")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    CancelFormButton(isDirty: isDirty, showingDiscard: $showingDiscard) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await save() }
                    } label: {
                        if isSaving { ProgressView() } else { Text("Save").bold() }
                    }
                    .disabled(!pending.isValid || isSaving)
                }
            }
            .onAppear {
                if draft.sourceId == nil, let presetSourceId {
                    draft.sourceId = presetSourceId
                }
                draft.purpose = presetPurpose
                if pristine == nil { pristine = draft }
            }
            .unsavedChangesGuard(isDirty: isDirty, showingDiscard: $showingDiscard) { dismiss() }
        }
    }

    private func save() async {
        guard case let .signedIn(user) = authStore.phase else {
            errorMessage = "Sign in expired. Sign in again to save."
            return
        }
        isSaving = true
        defer { isSaving = false }
        let result = await store.save(
            draft: pending,
            userId: user.id.uuidString,
            queueContext: modelContext
        )
        switch result {
        case .saved:
            HapticFeedback.success()
            dismiss()
        case .savedOffline:
            // Durably queued. It shows in the log now and reaches the server on
            // reconnect, which is what the seller needs to hear rather than a
            // failure they would go and re-enter.
            HapticFeedback.warning()
            dismiss()
        case .failed(let message):
            errorMessage = message
            HapticFeedback.error()
        }
    }
}
