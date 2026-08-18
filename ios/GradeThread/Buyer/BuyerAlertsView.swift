import SwiftUI
import Observation

// US-2503 AC2, screen 1 of 4: condition alerts.
//
// Standing searches the matching engine sweeps against newly-graded inventory,
// plus the matches it has already found. Reads and writes saved_searches
// directly under owner RLS, exactly as the web does — this is the buyer's own
// row and there is no policy to resolve, so routing it through the edge would
// add a hop and a second place to keep in step.

struct BuyerSavedSearch: Codable, Equatable, Identifiable {
    let id: String
    var label: String
    var brands: [String]
    var keywords: [String]
    var minGrade: Double?
    var maxPriceCents: Int?
    var isActive: Bool
    var lastMatchedAt: String?

    enum CodingKeys: String, CodingKey {
        case id
        case label
        case brands
        case keywords
        case minGrade = "min_grade"
        case maxPriceCents = "max_price_cents"
        case isActive = "is_active"
        case lastMatchedAt = "last_matched_at"
    }

    /// What this alert is actually looking for, in one line. An alert list where
    /// every row says only its label is a list of names, not of searches.
    var criteriaSummary: String {
        var parts: [String] = []
        if !brands.isEmpty { parts.append(brands.joined(separator: ", ")) }
        if !keywords.isEmpty { parts.append(keywords.joined(separator: ", ")) }
        if let minGrade { parts.append("grade \(BuyerAlertsView.gradeText(minGrade))+") }
        if let maxPriceCents { parts.append("under \(BuyerAlertsView.money(maxPriceCents))") }
        return parts.isEmpty ? "Anything newly graded" : parts.joined(separator: " - ")
    }
}

struct BuyerAlertMatch: Decodable, Equatable, Identifiable {
    let id: String
    let title: String
    let message: String
    let isRead: Bool
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id
        case title
        case message
        case isRead = "is_read"
        case createdAt = "created_at"
    }
}

/// The fields an iOS-created alert sets. Categories and sizes are deliberately
/// absent — see `BuyerAlertsView.editorNote`.
private struct NewSavedSearch: Encodable {
    let user_id: String
    let label: String
    let brands: [String]
    let keywords: [String]
    let min_grade: Double?
    let max_price_cents: Int?
    let is_active: Bool
}

private struct ActiveFlagPatch: Encodable {
    let is_active: Bool
}

@MainActor
@Observable
final class BuyerAlertsStore {

    struct Loaded: Equatable {
        var searches: [BuyerSavedSearch]
        var matches: [BuyerAlertMatch]
    }

    enum Phase: Equatable {
        case loading
        case ready(Loaded)
        case failed(String)
        case locked
    }

    private(set) var phase: Phase = .loading
    private(set) var actionError: String?
    private(set) var isMutating = false

    /// From the entitlement allowances. -1 means unlimited; the web uses the
    /// same convention and the same number.
    private(set) var activeCap: Int = 0

    private let service: BuyerAlertsServing

    /// The default is built in the BODY, not in the default argument value.
    /// iOS CI rejected `= BuyerAlertsService()` there with "call to main
    /// actor-isolated initializer in a synchronous nonisolated context".
    ///
    /// AND THE OBVIOUS GENERALISATION IS WRONG, which is worth writing down
    /// because I tried to build a guard on it. "A default argument cannot
    /// construct a @MainActor type" would flag seven call sites in this app
    /// that compile today - EbayAccountsStore, ReconciliationStore and five
    /// more all take `= SomeMainActorService()` and are fine. So the property
    /// that breaks is narrower than that, and I do not know it precisely
    /// enough to encode. What differs here is that this service is a struct
    /// whose isolation is INFERRED from a @MainActor protocol rather than
    /// declared on the type; the ones that work declare it. Resolving in the
    /// body sidesteps the question entirely and costs one line.
    init(service: BuyerAlertsServing? = nil) {
        self.service = service ?? BuyerAlertsService()
    }

    var activeCount: Int {
        guard case .ready(let loaded) = phase else { return 0 }
        return loaded.searches.filter(\.isActive).count
    }

    /// Whether another alert may be switched on. The cap is enforced HERE and
    /// on the web, and NOT in the database — so this is a courtesy, not a
    /// control. Said plainly because a reader could otherwise assume the row
    /// insert would be refused.
    var canActivateAnother: Bool {
        activeCap < 0 || activeCount < activeCap
    }

    func load(entitlements: BuyerEntitlementsStore) async {
        guard let capability = BuyerCapability.all.first(where: { $0.id == "conditionAlerts" }) else {
            phase = .failed("Condition alerts are unavailable.")
            return
        }
        guard entitlements.isIncluded(capability) else {
            phase = .locked
            return
        }
        activeCap = entitlements.entitlements.allowances.activeAlertsCap
        phase = .loading
        do {
            async let searches = service.searches()
            async let matches = service.matches()
            phase = .ready(Loaded(searches: try await searches, matches: try await matches))
        } catch {
            phase = .failed(
                (error as? LocalizedError)?.errorDescription
                    ?? "We couldn't load your alerts.")
        }
    }

    func setActive(_ search: BuyerSavedSearch, active: Bool) async {
        guard case .ready(var loaded) = phase else { return }
        guard let index = loaded.searches.firstIndex(where: { $0.id == search.id }) else { return }
        if active && !canActivateAnother {
            actionError = "Your plan runs \(activeCap) active alerts. Pause one first."
            return
        }
        let previous = loaded.searches[index].isActive
        loaded.searches[index].isActive = active
        phase = .ready(loaded)
        isMutating = true
        defer { isMutating = false }
        do {
            try await service.setActive(id: search.id, active: active)
            actionError = nil
        } catch {
            // Put the switch back. A toggle that stays flipped after a refused
            // write tells the buyer an alert is running when it is not, and
            // they find out by never being alerted.
            guard case .ready(var reverted) = phase,
                  let i = reverted.searches.firstIndex(where: { $0.id == search.id }) else { return }
            reverted.searches[i].isActive = previous
            phase = .ready(reverted)
            actionError = "We couldn't save that. Try again."
        }
    }

    func delete(_ search: BuyerSavedSearch) async {
        guard case .ready(var loaded) = phase else { return }
        isMutating = true
        defer { isMutating = false }
        do {
            try await service.delete(id: search.id)
            loaded.searches.removeAll { $0.id == search.id }
            phase = .ready(loaded)
            actionError = nil
        } catch {
            actionError = "We couldn't delete that alert. Try again."
        }
    }

    func create(label: String, brands: [String], keywords: [String], minGrade: Double?, maxPriceCents: Int?) async {
        guard case .ready(var loaded) = phase else { return }
        // A new alert arrives ACTIVE, so it counts against the cap before it is
        // written rather than after.
        guard canActivateAnother else {
            actionError = "Your plan runs \(activeCap) active alerts. Pause one first."
            return
        }
        isMutating = true
        defer { isMutating = false }
        do {
            let created = try await service.create(
                label: label.isEmpty ? "New alert" : label,
                brands: brands,
                keywords: keywords,
                minGrade: minGrade,
                maxPriceCents: maxPriceCents)
            loaded.searches.insert(created, at: 0)
            phase = .ready(loaded)
            actionError = nil
        } catch {
            actionError = "We couldn't create that alert. Try again."
        }
    }

    func clearActionError() { actionError = nil }
}

// MARK: - Service

/// @MainActor rather than Sendable. Every caller is the store, which is
/// MainActor-isolated, and a test double is naturally a MainActor class - which
/// cannot satisfy a nonisolated protocol requirement. The network work still
/// leaves the main thread at each await; only the call sites are pinned.
@MainActor
protocol BuyerAlertsServing {
    func searches() async throws -> [BuyerSavedSearch]
    func matches() async throws -> [BuyerAlertMatch]
    func setActive(id: String, active: Bool) async throws
    func delete(id: String) async throws
    func create(
        label: String,
        brands: [String],
        keywords: [String],
        minGrade: Double?,
        maxPriceCents: Int?
    ) async throws -> BuyerSavedSearch
}

struct BuyerAlertsService: BuyerAlertsServing {
    /// The notification type the matching engine writes. Must stay equal to the
    /// web's CONDITION_ALERT_TYPE (use-buyer-alert-matches.ts) — a mismatch
    /// shows an empty feed rather than an error, which is the worst way for a
    /// string to be wrong.
    static let conditionAlertType = "buyer_condition_alert"

    private static let matchLimit = 30

    // NOTE ON SCOPING, because the rule here is the OPPOSITE of the edge rule.
    // These reads go through the buyer’s own client, so owner RLS on
    // saved_searches and notifications is what scopes them. US-268’s "every
    // query must carry .eq(user_id)" applies to the edge service-role client,
    // which bypasses RLS; applying it here would be belt-and-braces, not the
    // control. The web reads the same two tables the same way.
    func searches() async throws -> [BuyerSavedSearch] {
        try await SupabaseShared.client
            .from("saved_searches")
            .select("id,label,brands,keywords,min_grade,max_price_cents,is_active,last_matched_at")
            .order("created_at", ascending: false)
            .execute()
            .value
    }

    func matches() async throws -> [BuyerAlertMatch] {
        try await SupabaseShared.client
            .from("notifications")
            .select("id,title,message,is_read,created_at")
            .eq("type", value: Self.conditionAlertType)
            .order("created_at", ascending: false)
            .limit(Self.matchLimit)
            .execute()
            .value
    }

    func setActive(id: String, active: Bool) async throws {
        try await SupabaseShared.client
            .from("saved_searches")
            .update(ActiveFlagPatch(is_active: active))
            .eq("id", value: id)
            .execute()
    }

    func delete(id: String) async throws {
        try await SupabaseShared.client
            .from("saved_searches")
            .delete()
            .eq("id", value: id)
            .execute()
    }

    func create(
        label: String,
        brands: [String],
        keywords: [String],
        minGrade: Double?,
        maxPriceCents: Int?
    ) async throws -> BuyerSavedSearch {
        let userId = try await SupabaseShared.client.auth.session.user.id.uuidString.lowercased()
        let payload = NewSavedSearch(
            user_id: userId,
            label: label,
            brands: brands,
            keywords: keywords,
            min_grade: minGrade,
            max_price_cents: maxPriceCents,
            is_active: true)
        let rows: [BuyerSavedSearch] = try await SupabaseShared.client
            .from("saved_searches")
            .insert(payload, returning: .representation)
            .select("id,label,brands,keywords,min_grade,max_price_cents,is_active,last_matched_at")
            .execute()
            .value
        guard let created = rows.first else {
            throw EdgeAPIError.serverError(detail: "The alert was not created.")
        }
        return created
    }
}

// MARK: - View

struct BuyerAlertsView: View {
    @Environment(BuyerEntitlementsStore.self) private var entitlements
    @State private var store = BuyerAlertsStore()
    @State private var showingEditor = false

    var body: some View {
        List {
            switch store.phase {
            case .loading:
                HStack { Spacer(); ProgressView(); Spacer() }
                    .listRowBackground(Color.clear)
            case .locked:
                lockedSection
            case .failed(let message):
                failedSection(message)
            case .ready(let loaded):
                alertsSection(loaded.searches)
                matchesSection(loaded.matches)
            }
        }
        .navigationTitle("Condition alerts")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if case .ready = store.phase {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showingEditor = true
                    } label: {
                        Label("New alert", systemImage: "plus")
                    }
                }
            }
        }
        .sheet(isPresented: $showingEditor) {
            NavigationStack {
                BuyerAlertEditor { label, brands, keywords, minGrade, maxPriceCents in
                    await store.create(
                        label: label,
                        brands: brands,
                        keywords: keywords,
                        minGrade: minGrade,
                        maxPriceCents: maxPriceCents)
                }
            }
        }
        .alert("Alerts", isPresented: Binding<Bool>(
            get: { store.actionError != nil },
            set: { presented in if !presented { store.clearActionError() } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(store.actionError ?? "")
        }
        .refreshable { await store.load(entitlements: entitlements) }
        .task { await store.load(entitlements: entitlements) }
    }

    // MARK: - Sections

    private func alertsSection(_ searches: [BuyerSavedSearch]) -> some View {
        Section {
            if searches.isEmpty {
                Text("No alerts yet. Add one and we'll tell you when something matching it gets graded.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(searches) { search in
                    row(search)
                }
            }
        } header: {
            Text("Your alerts")
        } footer: {
            Text(Self.capFooter(active: store.activeCount, cap: store.activeCap))
        }
    }

    private func row(_ search: BuyerSavedSearch) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Toggle(isOn: Binding(
                get: { search.isActive },
                set: { active in Task { await store.setActive(search, active: active) } }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(search.label).font(.subheadline)
                    Text(search.criteriaSummary)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .disabled(store.isMutating)
        }
        .swipeActions {
            Button(role: .destructive) {
                Task { await store.delete(search) }
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(search.label). \(search.criteriaSummary). \(search.isActive ? "Active" : "Paused")")
    }

    private func matchesSection(_ matches: [BuyerAlertMatch]) -> some View {
        Section {
            if matches.isEmpty {
                // An empty match feed is NOT an empty alert list, and must not
                // read like one — the buyer's setup is running, it just has not
                // caught anything yet.
                Text("Nothing has matched yet. Your alerts are running.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(matches) { match in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(match.title).font(.subheadline)
                        Text(match.message).font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 2)
                    .accessibilityElement(children: .combine)
                }
            }
        } header: {
            Text("Recent matches")
        }
    }

    private var lockedSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text("Your plan doesn't include condition alerts.")
                    .font(.subheadline)
                Text("Alerts watch newly graded items for what you're after - a brand, a keyword, a condition floor - and tell you the moment one shows up.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 4)
        }
    }

    private func failedSection(_ message: String) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Text("We couldn't load your alerts. They're still running - this is a display problem.")
                    .font(.subheadline)
                Text(message).font(.caption).foregroundStyle(.secondary)
                Button("Try again") {
                    Task { await store.load(entitlements: entitlements) }
                }
                .font(.subheadline)
            }
            .padding(.vertical, 4)
        }
    }

    // MARK: - Copy helpers

    static func money(_ cents: Int?) -> String {
        guard let cents else { return "-" }
        return String(format: "$%.2f", Double(cents) / 100)
    }

    static func gradeText(_ grade: Double) -> String {
        grade == grade.rounded() ? "\(Int(grade))" : String(format: "%.1f", grade)
    }

    static func capFooter(active: Int, cap: Int) -> String {
        if cap < 0 { return "\(active) active - unlimited on your plan." }
        return "\(active) of \(cap) active alerts used."
    }

    /// Said on the editor, not hidden. Category and size filters exist on the
    /// web and are not in this form yet; a buyer who set one there will still
    /// have it, because this screen never writes those columns.
    static let editorNote =
        "Category and size filters are set on the web. Anything you've already set there stays as it is."
}

// MARK: - Editor

struct BuyerAlertEditor: View {
    typealias Save = @MainActor (String, [String], [String], Double?, Int?) async -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var label = ""
    @State private var brands = ""
    @State private var keywords = ""
    @State private var minGrade = ""
    @State private var maxPrice = ""
    @State private var saving = false

    let onSave: Save

    var body: some View {
        Form {
            Section {
                TextField("Name this alert", text: $label)
            }
            Section {
                TextField("Brands, separated by commas", text: $brands)
                    .textInputAutocapitalization(.words)
                TextField("Keywords, separated by commas", text: $keywords)
                    .textInputAutocapitalization(.never)
            } header: {
                Text("What to watch for")
            } footer: {
                Text(BuyerAlertsView.editorNote)
            }
            Section {
                TextField("Lowest grade, 1 to 10", text: $minGrade)
                    .keyboardType(.decimalPad)
                TextField("Most you'd pay, in dollars", text: $maxPrice)
                    .keyboardType(.decimalPad)
            } header: {
                Text("Limits")
            } footer: {
                Text("Leave either blank for no limit.")
            }
        }
        .navigationTitle("New alert")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    saving = true
                    Task {
                        await onSave(
                            label.trimmingCharacters(in: .whitespaces),
                            BuyerAlertEditor.splitList(brands),
                            BuyerAlertEditor.splitList(keywords),
                            BuyerAlertEditor.parseGrade(minGrade),
                            BuyerAlertEditor.parseCents(maxPrice))
                        saving = false
                        dismiss()
                    }
                }
                .disabled(saving)
            }
        }
    }

    /// Splits a comma list, dropping blanks and duplicates. A trailing comma is
    /// the ordinary way a person finishes typing a list, and it must not become
    /// an empty brand that matches everything.
    static func splitList(_ raw: String) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for part in raw.split(separator: ",") {
            let trimmed = part.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { continue }
            let key = trimmed.lowercased()
            if seen.contains(key) { continue }
            seen.insert(key)
            out.append(trimmed)
        }
        return out
    }

    /// nil for blank or nonsense, and CLAMPED to the real scale. A typed "80"
    /// would otherwise store a floor no garment can ever meet, and the alert
    /// would sit there active and silent forever.
    static func parseGrade(_ raw: String) -> Double? {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, let value = Double(trimmed), value.isFinite else { return nil }
        return min(10, max(1, value))
    }

    /// Dollars in, cents out. Rejects negatives rather than storing a cap that
    /// nothing can be under.
    static func parseCents(_ raw: String) -> Int? {
        let trimmed = raw
            .trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: ",", with: "")
        guard !trimmed.isEmpty, let dollars = Double(trimmed), dollars.isFinite, dollars > 0 else {
            return nil
        }
        return Int((dollars * 100).rounded())
    }
}
