import MapKit
import SwiftData
import SwiftUI

/// US-1866 — Thrift Radar on the phone: "is this store worth walking into?"
///
/// A ranked LIST first, and that is still the decision: standing in a car park,
/// the useful thing is an ordering — nearest-and-busiest first — not a canvas to
/// pan. The web surface (US-1865) and this one read the same endpoint and score
/// with the same arithmetic (``RadarScoring``, ported from
/// `src/lib/radar-map.ts`), so a store cannot read "Busiest near you" on one and
/// "Quiet" on the other.
///
/// ⚠️ US-3106 ADDED A MAP, and the header here used to say it never would.
/// The reasoning has not changed, only what it rules out: **tile URLs ARE the
/// viewport**, so a third-party tile map streams the seller's neighbourhood to
/// whoever serves the tiles — the disclosure US-1862's geohash cells exist to
/// withhold, and still refused. MapKit is Apple's framework on Apple's device,
/// under terms the seller already accepted, with no host for the ATS allowlist
/// and no subprocessor to declare. The pins are cell centres, identical for
/// everyone in the cell. See ``RadarMapPin``.
struct RadarNearbyView: View {

    @State private var store = RadarStore()
    @Environment(NetworkMonitor.self) private var networkMonitor: NetworkMonitor?

    /// US-3106: the venue a map pin selected, so the list can scroll to it and
    /// mark it. Nil until a pin is tapped.
    @State private var selectedPinId: String?
    /// US-3106: which source is being linked to which venue, if any. ONE sheet
    /// slot on this view (`check-chained-sheets`).
    @State private var linkTarget: RadarLinkTarget?

    var body: some View {
        ScrollViewReader { proxy in
            List {
                windowSection
                statusSection
                mapSection
                nearbySection
                offMapSection
                pitchSection
            }
            .listStyle(.insetGrouped)
            .onChange(of: selectedPinId) { _, id in
                guard let id else { return }
                // The pin is the pointer; the ROW is where the numbers are. A
                // map that highlighted a dot and left the seller to find the
                // matching line themselves would be a second thing to read.
                withAnimation { proxy.scrollTo(id, anchor: .center) }
            }
        }
        .navigationTitle("Nearby")
        .navigationBarTitleDisplayMode(.inline)
        .task { await store.load() }
        .refreshable { await store.refresh() }
        .sheet(item: $linkTarget) { target in
            RadarLinkSourceSheet(
                target: target,
                link: { sourceId, venueId in
                    await store.link(sourceId: sourceId, venueId: venueId)
                },
                venues: store.rows
            )
        }
    }

    // MARK: - Map (US-3106)

    /// The pins, or nothing at all.
    ///
    /// Hidden until the seller has turned contributions ON. Viewing is not
    /// contributing everywhere else on this screen (``RadarCopy``), and this is
    /// deliberately stricter: a map is the surface that makes "where this person
    /// is" legible at a glance, so it waits for the same explicit yes the
    /// location collection waits for.
    @ViewBuilder private var mapSection: some View {
        let pins = RadarMapPin.pins(from: store.rows)
        if store.isContributing, !pins.isEmpty, let region = RadarMapPin.region(for: pins) {
            Section {
                Map(initialPosition: .region(MKCoordinateRegion(
                    center: CLLocationCoordinate2D(
                        latitude: region.centerLat,
                        longitude: region.centerLng
                    ),
                    span: MKCoordinateSpan(
                        latitudeDelta: region.spanLat,
                        longitudeDelta: region.spanLng
                    )
                ))) {
                    ForEach(pins) { pin in
                        Annotation(pin.name, coordinate: pin.coordinate) {
                            pinMarker(pin)
                        }
                    }
                }
                .frame(height: 240)
                .listRowInsets(EdgeInsets())
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            } footer: {
                Text(String(localized: "Pins sit at the centre of an approximate area, not at an exact address."))
            }
        }
    }

    private func pinMarker(_ pin: RadarMapPin) -> some View {
        Button {
            AppRouter.haptic()
            selectedPinId = pin.id
        } label: {
            VStack(spacing: 2) {
                Image(systemName: pin.isMine ? "bag.circle.fill" : "mappin.circle.fill")
                    .font(.title2)
                    // One switch for the band, shared with the list badge
                    // (`RadarHotnessLevel.tint`), so the pin and the row cannot
                    // disagree about the same score.
                    .foregroundStyle(pin.level?.tint ?? .secondary)
                    .background(Circle().fill(.background))
                if pin.id == selectedPinId {
                    Text(pin.name)
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(Color.brandNavy, in: Capsule())
                        .foregroundStyle(.white)
                        .lineLimit(1)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(pin.name))
    }

    // MARK: - Controls

    private var windowSection: some View {
        Section {
            Picker(
                "Activity window",
                selection: Binding(
                    get: { store.window },
                    set: { next in Task { await store.setWindow(next) } }
                )
            ) {
                ForEach(RadarWindow.allCases) { window in
                    Text(window.shortLabel).tag(window)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityLabel("Activity window")

            Button {
                AppRouter.haptic()
                Task { await store.useMyLocation() }
            } label: {
                HStack {
                    Label(
                        store.isLocating ? "Locating…" : "Use my location",
                        systemImage: "location"
                    )
                    Spacer()
                    if store.isLocating { ProgressView() }
                }
            }
            .disabled(store.isLocating || !store.canAskForLocation)
            .tint(Color.brandNavy)

            if store.locationDenied || !store.canAskForLocation {
                // A dead switch would be worse than an explanation: iOS will not
                // re-prompt once answered, so the only route back is Settings.
                Text("Location is off for GradeThread. Turn it on in iOS Settings → Privacy → Location Services to sort by what is near you. Radar still works without it.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if let message = store.locationError {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(Color.brandAmber)
            }
        } header: {
            Text("Window")
        } footer: {
            Text(RadarCopy.viewingIsNotContributing)
        }
    }

    // MARK: - Status

    @ViewBuilder private var statusSection: some View {
        if NetworkMonitor.isOffline(networkMonitor) {
            Section {
                // Degrades rather than blocks: the personal layer below is
                // whatever we last loaded, and it is still the answer to "have I
                // done well here before".
                OfflineNotice(intent: .blocked, detail: "to refresh the shared map")
            }
        }

        if let message = store.personalError {
            Section {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(Color.brandRed)
                Button("Try again") { Task { await store.loadPersonal() } }
                    .font(.footnote.weight(.semibold))
            }
        }

        if store.networkLocked {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text("The shared map is on Pro")
                        .font(.subheadline.weight(.semibold))
                    // Naming what is NOT behind the wall matters: a prompt that
                    // implies the whole screen is paid would be selling the
                    // reseller something they already have.
                    Text("Hotness, brand mix and busy days come from everyone else's scans. Your own stores and your own numbers stay on this list on every plan.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button("Check again") {
                        AppRouter.haptic()
                        Task { await store.checkNetworkAgain() }
                    }
                    .font(.footnote.weight(.semibold))
                    .buttonStyle(.bordered)
                    .tint(Color.brandNavy)
                }
            }
        } else if let message = store.networkError {
            Section {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(Color.brandAmber)
                Button("Try again") { Task { await store.loadNetwork() } }
                    .font(.footnote.weight(.semibold))
            }
        }
    }

    // MARK: - The list

    @ViewBuilder private var nearbySection: some View {
        Section {
            if store.isLoadingPersonal && store.rows.isEmpty {
                HStack {
                    ProgressView()
                    Text("Loading your stores…")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            } else if store.rows.isEmpty {
                emptyState
            } else {
                ForEach(store.rows) { row in
                    Group {
                        if let venueId = row.venueId {
                            NavigationLink {
                                RadarVenueDetailView(
                                    venueId: venueId,
                                    name: row.name,
                                    window: store.window,
                                    personal: row.personal
                                )
                            } label: {
                                RadarRowView(row: row)
                            }
                        } else {
                            RadarRowView(row: row)
                        }
                    }
                    // US-3106: the anchor a tapped pin scrolls to, and the tint
                    // that says which row it was.
                    .id(row.id)
                    .listRowBackground(
                        row.id == selectedPinId
                            ? Color.brandNavy.opacity(0.08)
                            : Color(uiColor: .secondarySystemGroupedBackground)
                    )
                }
            }
        } header: {
            HStack {
                Text("Nearby")
                Spacer()
                if store.isLoadingNetwork { ProgressView() }
            }
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                if store.kFloor > 0 {
                    Text("A store appears once \(store.kFloor) different people have scanned there.")
                }
                if !store.weights.isEmpty {
                    Text("Weighted toward \(store.weights.map(\.brand).joined(separator: ", ")) — the brands your own pipeline says you flip.")
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Nothing on the radar here yet")
                .font(.subheadline.weight(.medium))
            // The honest reading of a k-floored silence: not "no stores", but
            // "nothing we can say without giving away who scanned".
            Text(String(localized: "Share your location to look around you, or link one of your sources to a place so your own stores show up here."))
                .font(.caption)
                .foregroundStyle(.secondary)
            // US-3106: this used to say "on the web". A seller reading it is
            // standing in a car park, and the one thing the sentence asked of
            // them was the one thing the phone could not do.
            Button {
                AppRouter.haptic()
                linkTarget = RadarLinkTarget(sourceId: nil, venueId: nil, venueName: nil)
            } label: {
                Label(String(localized: "Link a source"), systemImage: "link")
                    .font(.caption.weight(.semibold))
            }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder private var offMapSection: some View {
        if !store.offMapStores.isEmpty {
            Section {
                ForEach(store.offMapStores.prefix(6)) { item in
                    // US-3106: the row IS the link action now. Reading "link it
                    // on the web" while holding the phone that could do it was
                    // the whole complaint.
                    Button {
                        AppRouter.haptic()
                        linkTarget = RadarLinkTarget(
                            sourceId: item.sourceId,
                            venueId: nil,
                            venueName: nil
                        )
                    } label: {
                        HStack {
                            Text(item.name).lineLimit(1)
                            Spacer()
                            Text("\(item.itemsSourced) item\(item.itemsSourced == 1 ? "" : "s")")
                                .font(.caption)
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                            Image(systemName: "link")
                                .font(.caption2)
                                .foregroundStyle(Color.brandNavy)
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(item.sourceId == nil)
                }
            } header: {
                Text("Your stores that are not on the map")
            } footer: {
                Text(String(localized: "These have your money in them but no place yet. Tap one to say which store on the map it is, and it joins this list."))
            }
        }
    }

    private var pitchSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Label("Empty radar near you?", systemImage: "sparkles")
                    .font(.subheadline.weight(.medium))
                Text(RadarCopy.contributionPitch)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(
                    store.isContributing
                        ? "Contributions are on for this account. You can turn them off any time in Settings."
                        : "Contributions are off. The switch is in Settings → Thrift Radar."
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
    }
}

// MARK: - Row

private struct RadarRowView: View {
    let row: RadarNearbyRow

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(row.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 8)
                if let level = row.level {
                    Text(level.label)
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(hotnessTint(level).opacity(0.16), in: Capsule())
                        .foregroundStyle(hotnessTint(level))
                }
            }

            if let network = row.network {
                Text("\(network.scanCount) scan\(network.scanCount == 1 ? "" : "s") · \(network.contributorCount) people · \(RadarScoring.freshnessLabel(daysSince: network.daysSinceActivity))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                // Deliberately not "no activity": we did not look and find it
                // quiet, we were told nothing.
                Text("Your store · nothing shared about this place yet")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 8) {
                if let distance = row.distanceKm {
                    Label(distanceLabel(distance), systemImage: "location.fill")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if let personal = row.personal, personal.itemsSourced > 0 {
                    Label(
                        "\(personal.itemsSourced) sourced here",
                        systemImage: "bag"
                    )
                    .font(.caption2)
                    .foregroundStyle(Color.brandNavy)
                }
            }
        }
        .padding(.vertical, 2)
    }

    private func distanceLabel(_ km: Double) -> String {
        // Locale-aware: the same number reads as miles where miles are used.
        let measurement = Measurement(value: km, unit: UnitLength.kilometers)
        let formatter = MeasurementFormatter()
        formatter.unitOptions = [.providedUnit]
        formatter.numberFormatter.maximumFractionDigits = km < 10 ? 1 : 0
        if Locale.current.measurementSystem == .us {
            return formatter.string(from: measurement.converted(to: .miles))
        }
        return formatter.string(from: measurement)
    }

    /// A four-step ramp, one flat colour per level — no gradient, so the badge
    /// survives a screenshot and pairs with the text label beside it.
    ///
    /// US-3106 moved the switch onto ``RadarHotnessLevel`` so the map pin reads
    /// the same one. Two copies is how a store shows amber on the list and red
    /// on the map, and tells the seller the app disagrees with itself.
    private func hotnessTint(_ level: RadarHotnessLevel) -> Color { level.tint }
}

// MARK: - Detail

/// Venue detail, in parity with the web panel.
///
/// Every section can be absent, and the reason is always the same one: the
/// k-anonymity floor is enforced on the SERVER, and a below-floor group comes
/// back as no row rather than as a redacted payload. There is nothing here to
/// hide — there is only a hole, and this view's job is to say what the hole
/// means instead of drawing an empty chart that reads as a finding.
struct RadarVenueDetailView: View {

    let venueId: String
    let name: String
    let window: RadarWindow
    let personal: RadarPersonalStore?

    @State private var store = RadarVenueDetailStore()

    var body: some View {
        List {
            if let personal {
                Section {
                    PersonalSummaryRow(store: personal)
                } header: {
                    Text("Your history here")
                } footer: {
                    Text("Your own numbers, on every plan. They are not part of the shared map.")
                }
            }

            switch store.phase {
            case .loading:
                Section {
                    HStack {
                        ProgressView()
                        Text("Loading…").foregroundStyle(.secondary)
                    }
                }
            case .withheld(let message, let planGated):
                Section {
                    Label {
                        Text(message).font(.footnote)
                    } icon: {
                        Image(systemName: "lock")
                    }
                    .foregroundStyle(.secondary)
                    if !planGated {
                        // A retry only makes sense when something transient
                        // might have failed. Behind a plan wall the upgrade
                        // sheet is already up and a second attempt is a loop.
                        Button("Try again") {
                            Task { await store.load(venueId: venueId, window: window) }
                        }
                        .font(.footnote.weight(.semibold))
                    }
                }
            case .ready(let detail):
                headerSection(detail)
                brandSection(detail)
                conditionSection(detail)
                busySection(detail)
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .task { await store.load(venueId: venueId, window: window) }
    }

    // MARK: Sections

    private func headerSection(_ detail: RadarVenueDetailPayload) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text(detail.venue.displayName)
                    .font(.brandTitle2)
                Text(
                    RadarScoring.freshnessLabel(daysSince: detail.network.daysSinceActivity)
                        + (detail.venue.chain.map { " · \($0)" } ?? "")
                )
                .font(.caption)
                .foregroundStyle(.secondary)
                HStack(spacing: 8) {
                    chip("\(detail.network.scanCount) scan\(detail.network.scanCount == 1 ? "" : "s")")
                    chip("\(detail.network.contributorCount) people")
                    if let rate = detail.network.buyRate {
                        chip("\(Int((rate * 100).rounded()))% worth buying")
                    }
                }
            }
        }
    }

    private func brandSection(_ detail: RadarVenueDetailPayload) -> some View {
        Section {
            if detail.brands.isEmpty {
                withheld(RadarCopy.notEnough)
            } else {
                let peak = max(detail.brands.map(\.scanCount).max() ?? 1, 1)
                ForEach(detail.brands.prefix(8), id: \.brand) { brand in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text((brand.brand ?? "—").capitalized)
                                .font(.subheadline)
                                .lineLimit(1)
                            Spacer()
                            Text("\(brand.scanCount)")
                                .font(.caption)
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                        }
                        bar(share: Double(brand.scanCount) / Double(peak), tint: Color.brandNavy)
                    }
                    .padding(.vertical, 2)
                }
            }
        } header: {
            Text("Brand mix")
        } footer: {
            Text("Only brands enough different people have scanned appear here. A brand missing from this list is not a brand missing from the store.")
        }
    }

    private func conditionSection(_ detail: RadarVenueDetailPayload) -> some View {
        let mix = detail.network.gradeMix
        return Section {
            if mix.graded == 0 {
                withheld("Nothing scanned here has been graded yet, so there is no condition picture to show.")
            } else {
                gradeRow("8+ (great)", count: mix.high, of: mix.graded, tint: .green)
                gradeRow("6–8 (wearable)", count: mix.mid, of: mix.graded, tint: Color.brandAmber)
                gradeRow("Under 6 (rough)", count: mix.low, of: mix.graded, tint: .secondary)
            }
        } header: {
            Text("Condition found here")
        } footer: {
            if mix.graded > 0 {
                Text("Averages \(detail.network.avgGrade.map { String(format: "%.1f", $0) } ?? "—") out of 10 across \(mix.graded) graded scan\(mix.graded == 1 ? "" : "s"). Estimated from photos in the field, not a certified grade."
                    + (mix.ungraded > 0 ? " \(mix.ungraded) scan\(mix.ungraded == 1 ? "" : "s") had no grade." : ""))
            } else {
                Text("Estimated grades from field scans, not certified grades.")
            }
        }
    }

    private func busySection(_ detail: RadarVenueDetailPayload) -> some View {
        let bars = RadarScoring.dayBars(detail.network.activityByDay)
        let busiest = RadarScoring.busiestDayLabel(detail.network.activityByDay)
        return Section {
            if let bars {
                HStack(alignment: .bottom, spacing: 8) {
                    ForEach(bars) { day in
                        VStack(spacing: 4) {
                            RoundedRectangle(cornerRadius: 3, style: .continuous)
                                .fill(day.busiest ? Color.brandRed : Color.brandNavy.opacity(0.55))
                                .frame(height: max(4, day.share * 48))
                            Text(day.label)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("\(day.label): \(day.count) scan\(day.count == 1 ? "" : "s")")
                    }
                }
                .frame(height: 72)
                .padding(.vertical, 4)
            } else {
                withheld(RadarCopy.notEnough)
            }
        } header: {
            Text("When it is busy")
        } footer: {
            Text(
                busiest.map { "Most scans land on \($0), in this store's local time." }
                    ?? "Scans by day of the week, in this store's local time."
            )
        }
    }

    // MARK: Bits

    private func chip(_ text: String) -> some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Color.secondary.opacity(0.14), in: Capsule())
    }

    private func withheld(_ message: String) -> some View {
        Label {
            Text(message).font(.footnote)
        } icon: {
            Image(systemName: "lock")
        }
        .foregroundStyle(.secondary)
    }

    private func gradeRow(_ label: String, count: Int, of total: Int, tint: Color) -> some View {
        let pct = total > 0 ? Int((Double(count) / Double(total) * 100).rounded()) : 0
        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(label).font(.subheadline)
                Spacer()
                Text("\(pct)%").font(.caption).monospacedDigit().foregroundStyle(.secondary)
            }
            bar(share: Double(pct) / 100, tint: tint)
        }
        .padding(.vertical, 2)
    }

    private func bar(share: Double, tint: Color) -> some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.15))
                Capsule()
                    .fill(tint)
                    .frame(width: max(2, geo.size.width * RadarScoring.clamp(share, 0, 1)))
            }
        }
        .frame(height: 8)
        .accessibilityHidden(true)
    }
}

/// The reseller's own numbers for a place. Free, ungated, shown even when the
/// network layer has nothing — the question "have I done well here before"
/// outranks "are strangers busy here".
private struct PersonalSummaryRow: View {
    let store: RadarPersonalStore

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if store.itemsSourced > 0 {
                Text("\(store.itemsSourced) item\(store.itemsSourced == 1 ? "" : "s") sourced · \(money(store.spendCents)) spent · \(money(store.realizedProfitCents)) profit so far")
                    .font(.subheadline)
            } else {
                Text("\(store.visits) visit\(store.visits == 1 ? "" : "s") recorded, nothing bought yet.")
                    .font(.subheadline)
            }
            if let roi = store.roiPct {
                Text("\(Int(roi.rounded()))% blended ROI")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 2)
    }

    private func money(_ cents: Int) -> String {
        CurrencyFormatter.shared.formatDisplay(Double(cents) / 100)
    }
}
