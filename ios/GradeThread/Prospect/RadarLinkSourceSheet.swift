import SwiftData
import SwiftUI

/// What the link sheet opens on. Either half may be pre-filled: tapping an
/// off-map store knows the source, tapping a venue knows the place.
struct RadarLinkTarget: Identifiable, Equatable {
    let sourceId: String?
    let venueId: String?
    let venueName: String?

    /// Stable across the sheet's life. The two ids together, because a nil id
    /// is a legitimate state and `Identifiable` needs something either way.
    var id: String { "\(sourceId ?? "-")|\(venueId ?? "-")" }
}

/// US-3106 — link one of your sources to a place on the map, from the phone.
///
/// This is the join that makes the personal layer whole: money lives on a
/// SOURCE (items, spend, sales) and visits live on a VENUE, and until somebody
/// says they are the same shop the two halves cannot meet. Until now that
/// somebody had to be at a desk — both empty states on the Radar screen told a
/// seller standing in a car park to go and do it on the web, which is the one
/// moment they cannot.
///
/// The sources come from the LOCAL mirror (`LocalSource`), so the picker fills
/// instantly and works with no signal. The link itself is a write and needs the
/// network; a failure says so and changes nothing.
struct RadarLinkSourceSheet: View {
    let target: RadarLinkTarget
    /// Performs the link. Returns an error message, or nil on success.
    let link: (String, String?) async -> String?

    @Environment(\.dismiss) private var dismiss

    /// Active sources only. An archived one is hidden from every other picker
    /// (US-814) and linking a place to a source the seller has retired would put
    /// their money on a store they cannot choose again.
    @Query(
        filter: #Predicate<LocalSource> { $0.archivedAt == nil },
        sort: \LocalSource.name
    )
    private var sources: [LocalSource]

    @State private var selectedSourceId: String?
    @State private var selectedVenueId: String?
    @State private var isSaving = false
    @State private var errorMessage: String?

    /// Venues to offer when the sheet was opened without one.
    ///
    /// Passed in rather than fetched: the Radar screen already holds the served
    /// list, and a second request for the same rectangle would be a second
    /// query about where the seller is.
    var venues: [RadarNearbyRow] = []

    var body: some View {
        NavigationStack {
            Form {
                sourceSection
                venueSection
                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle")
                            .font(.caption)
                            .foregroundStyle(Color.brandRed)
                    }
                }
            }
            .navigationTitle("Link a source")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        Task { await save() }
                    } label: {
                        if isSaving { ProgressView() } else { Text(String(localized: "Link")) }
                    }
                    .disabled(!canSave)
                }
            }
            .onAppear {
                selectedSourceId = target.sourceId ?? sources.first?.id
                selectedVenueId = target.venueId
            }
        }
    }

    private var canSave: Bool {
        !isSaving && selectedSourceId != nil && selectedVenueId != nil
    }

    @ViewBuilder private var sourceSection: some View {
        Section {
            if sources.isEmpty {
                // Nothing to link, and saying which half is missing is the
                // difference between a dead sheet and a next step.
                Text(String(localized: "You have no sources yet. Add one on an item's Sourced-from field, then come back."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Picker("Source", selection: $selectedSourceId) {
                    ForEach(sources) { source in
                        Text(source.name).tag(String?.some(source.id))
                    }
                }
            }
        } header: {
            Text(String(localized: "Your source"))
        } footer: {
            Text(String(localized: "The place your money is recorded against — where you bought the item."))
        }
    }

    @ViewBuilder private var venueSection: some View {
        Section {
            if let name = target.venueName, target.venueId != nil {
                LabeledContent("Store", value: name)
            } else if linkableVenues.isEmpty {
                Text(String(localized: "No stores on the map here yet. Tap Use my location on the Nearby screen first."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Picker("Store", selection: $selectedVenueId) {
                    Text(String(localized: "Choose a store")).tag(String?.none)
                    ForEach(linkableVenues) { row in
                        Text(row.name).tag(row.venueId)
                    }
                }
            }
        } header: {
            Text(String(localized: "Store on the map"))
        } footer: {
            Text(String(localized: "Linking joins your own numbers to what everyone else has found there. Nothing about your source is shared."))
        }
    }

    /// Rows that name a real venue. One of the seller's own unlinked sources
    /// carries no venue id and cannot be the target of a link.
    private var linkableVenues: [RadarNearbyRow] {
        venues.filter { $0.venueId != nil }
    }

    private func save() async {
        guard let sourceId = selectedSourceId, let venueId = selectedVenueId else { return }
        isSaving = true
        errorMessage = nil
        defer { isSaving = false }
        if let failure = await link(sourceId, venueId) {
            errorMessage = failure
            return
        }
        dismiss()
    }
}
