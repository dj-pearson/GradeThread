import SwiftUI

extension Notification.Name {
    /// US-1262: posted when a "reconnect eBay" notification action is tapped, so
    /// the Marketplaces surface auto-presents the eBay OAuth/reconnect sheet
    /// instead of leaving the user to find the Reconnect button.
    static let ebayReconnectRequested = Notification.Name("com.gradethread.app.ebayReconnectRequested")
}

/// US-1262: a one-shot latch bridging a "reconnect eBay" deep link to the
/// Marketplaces surface. The deep link can arrive BEFORE the tab's view mounts
/// (cold launch / a tab the user has never opened — so its `.onReceive` isn't
/// subscribed yet) OR while it's already live. The latch covers the cold case
/// (consumed in the view's `.task` on first appear) and the
/// `.ebayReconnectRequested` wake signal covers the live case (`.onReceive`).
/// `consume()` returns true at most once per `request()`, so the two paths can't
/// both fire a duplicate OAuth.
@MainActor
final class EbayReconnectLatch {
    static let shared = EbayReconnectLatch()
    private var pending = false
    private init() {}

    func request() { pending = true }

    func consume() -> Bool {
        guard pending else { return false }
        pending = false
        return true
    }
}

/// Marketplaces tab. Today: just the eBay connection card. Future
/// platforms (Poshmark / Mercari / Depop) get their own cards alongside
/// when US-149 lands.
struct MarketplacesView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.syncEngine) private var syncEngine
    @Environment(AuthStore.self) private var authStore
    @State private var store = MarketplaceConnectionStore()

    // US-184 sync
    @State private var syncStore = EbaySyncStore()
    // US-1007: retained so dismissing the modal cancels the poll loop promptly.
    @State private var syncTask: Task<Void, Never>?
    // US-1189: gate "Sync now" while a sync is live (prevents duplicate runs)
    // and confirm before disconnecting from the main card.
    @State private var isSyncing = false
    @State private var confirmingDisconnect = false
    // US-2531: the web page where a .api channel is actually connected. An
    // Identifiable wrapper drives one .sheet(item:) - the same shape the
    // Settings legal links use - so a second web-managed channel needs no new
    // state.
    /// One optional driving ONE `.sheet(item:)`. A view has a single sheet
    /// slot, so two `.sheet` modifiers on it compete for that slot and the
    /// loser presents and is torn down in the same frame — see ``ToolModule``
    /// and `Scripts/check-chained-sheets.py`.
    @State private var sheet: MarketplacesSheet?

    /// The sheets the marketplaces tab presents.
    private enum MarketplacesSheet: Identifiable {
        /// US-2531: a web-managed channel, opened in-app rather than kicked
        /// out to Safari, so the seller comes back to where they were.
        case webChannel(WebManagedChannel)
        /// US-184: the eBay sync modal, which owns a poll task.
        case sync

        var id: String {
            switch self {
            case .webChannel(let channel): return "web-\(channel.id)"
            case .sync:                    return "sync"
            }
        }
    }

    // US-186 reconciliation count badge — refreshed alongside connection
    // state so the link only shows up when there's actually orphan work.
    @State private var orphanCount: Int = 0
    /// US-645: track whether the last orphan-count query *failed* so a network
    /// error doesn't masquerade as "all reconciled" (count silently 0) and make
    /// the reconciliation card vanish.
    @State private var orphanCheckFailed = false
    // US-2481: extension work queued from this phone, waiting on the desktop.
    @State private var queuePending: [ExtensionQueueService.QueueItem] = []
    @State private var queueNeedsAttention: [ExtensionQueueService.QueueItem] = []
    // US-2481 AC1: listings that sold elsewhere and are STILL LIVE on an
    // extension channel. Read on the phone for the first time here — the stamp
    // existed since US-717 but only the web dashboard ever showed it.
    @State private var pendingDelists: [PendingDelistService.PendingDelist] = []
    @State private var delistBusyId: String?
    @State private var delistMessage: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                headerCard
                if let userId = currentUserId() {
                    connectionCard(userId: userId)
                    // US-671: manage multiple connected eBay stores.
                    if case .connected = store.phase {
                        ebayAccountsCard(userId: userId)
                        // US-673: best offers + buyer messages.
                        negotiationCard
                        // US-1043/1049: returns, cancellations, payment disputes.
                        postSaleCard
                        // US-1046: bulk price/quantity update.
                        bulkPricingCard
                    }
                    if orphanCheckFailed {
                        reconciliationErrorCard(userId: userId)
                    } else if orphanCount > 0 {
                        reconciliationCard
                    }
                    // US-289: photo-dump → reconcile-session intake.
                    reconcileIntakeCard(userId: userId)
                }
                // US-675: durable home for AutoLister-generated drafts + bulk edit.
                draftsCard
                // US-2481 AC1: ABOVE the queue section, because a listing that
                // is still live outranks the record of work already queued.
                pendingDelistSection
                // US-2481: work this phone queued that the desktop has not run.
                // Placed ABOVE the channel list because it answers the question a
                // seller actually has when they open this screen after queuing
                // something — "did that happen yet?" — and the honest answer is
                // "not until your browser opens."
                extensionQueueSection
                // US-668: phased multi-channel surface — eBay is live above;
                // the rest are surfaced as "coming soon" so the app reflects the
                // real multi-marketplace roadmap.
                comingSoonChannelsSection
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
        .navigationTitle("Marketplaces")
        .navigationBarTitleDisplayMode(.large)
        .task {
            if let userId = currentUserId() {
                await store.refresh(userId: userId)
                await refreshOrphanCount(userId: userId)
                // US-2481: read on every appearance rather than once. This is
                // the screen a seller opens to ask "did the thing I queued from
                // the shop run yet", and a cached answer is the wrong one.
                await refreshQueue()
                await refreshPendingDelists()
            }
            // US-1262: a reconnect deep link that mounted this tab is consumed
            // here (its `.onReceive` wasn't subscribed when the signal fired).
            consumeReconnectRequest()
        }
        .refreshable {
            if let userId = currentUserId() {
                await store.refresh(userId: userId)
                await refreshOrphanCount(userId: userId)
                // Pull-to-refresh is the gesture for "has it run yet"; before
                // US-2481 AC1 it was the one path that did not re-read either
                // list, so the answer stayed whatever it was on first appear.
                await refreshQueue()
                await refreshPendingDelists()
            }
        }
        // US-1262: a "reconnect eBay" notification action routes here and posts
        // this signal so the OAuth sheet opens automatically — the action is a
        // one-tap path back into the connection flow, not just the tab.
        .onReceive(NotificationCenter.default.publisher(for: .ebayReconnectRequested)) { _ in
            // Live case: the tab was already on-screen/mounted when the deep link
            // fired, so this subscription catches the wake signal.
            consumeReconnectRequest()
        }
        .sheet(item: $sheet) { presented in
            switch presented {
            case .webChannel(let channel):
                SafariView(url: channel.url).ignoresSafeArea()
            case .sync:
                // The poll loop is cancelled on the way out. Scoped to this case
                // rather than a shared onDismiss, and hung on onDisappear so a
                // swipe-to-dismiss (which never calls the modal's own callback)
                // cancels it too. cancelSync() is idempotent.
                EbaySyncModal(
                    store: syncStore,
                    onDismiss: { cancelSync() }
                )
                .onDisappear { cancelSync() }
            }
        }
        // US-1189: surface a failed disconnect (the store restores .connected).
        .alert(
            "Couldn't complete that",
            isPresented: Binding(
                get: { store.actionError != nil },
                set: { if !$0 { store.actionError = nil } }
            )
        ) {
            Button("OK") { store.actionError = nil }
        } message: {
            Text(store.actionError ?? "")
        }
    }

    // US-668 / US-718: phased channel abstraction. Each channel carries its REAL
    // capability tier (mirrors web MARKETPLACE_TIER) so the app never advertises a
    // channel above what actually ships. Adding a second *live in-app* channel
    // means adding a `.api` connection card here; the rest of the surface
    // (and cross-listing entry points) iterate over this list.
    private enum ChannelTier {
        // Live API connector. eBay is managed in-app (connectionCard above);
        // Shopify is web-only, and is the sole `.api` entry in `phasedChannels`
        // — hence the "manage on web" badge. A future in-app channel listed here
        // would need its own tier rather than reusing this badge.
        case api
        // US-745: no-API marketplaces now cross-list in-app via the copy/paste
        // Listing Kit (open a drafted item → Listing Kit), replacing the prior
        // "Coming soon" / browser-extension-only treatment for these platforms.
        case listingKit
        case comingSoon   // no integration yet

        var badge: String {
            switch self {
            case .api: return "Live · manage on web"
            case .listingKit: return "Copy & paste kit"
            case .comingSoon: return "Coming soon"
            }
        }
    }

    private struct MarketplaceChannel: Identifiable {
        let id: String
        let label: String
        let systemImage: String
        let tier: ChannelTier
    }

    /// US-2531: a channel that is real, paid for, and connected somewhere this
    /// app is not. The screen already SAID so in prose; saying it without a way
    /// to get there left an iPhone-only subscriber reading an instruction they
    /// could not follow.
    ///
    /// The destination is the FlipDesk marketplaces page rather than a Shopify
    /// OAuth URL. The OAuth handshake belongs to the web app, which owns the
    /// redirect target and the session that completes it; deep-linking past it
    /// would strand the seller on a callback nothing here can receive.
    struct WebManagedChannel: Identifiable {
        let id: String
        let label: String
        let url: URL
    }

    private static let webMarketplacesURL = URL(
        string: "https://gradethread.com/dashboard/flipdesk/marketplaces"
    )

    // US-2475: per-channel automation risk disclosure.
    //
    // MIRRORS `marketplaceDisclosureFor` in src/lib/constants.ts — the web copy
    // is the source, this is the hand-mirror (same pattern as ChannelTier.badge
    // mirroring MARKETPLACE_TIER_LABEL). Change the TypeScript first; a
    // difference in wording between the two clients is the bug this exists to
    // prevent, because a seller who reads one and acts on the other has been
    // told two different things about who is responsible for their account.
    //
    // Bright lines behind the extension wording:
    // vault/60-decisions/adr-no-server-side-marketplace-automation.md.
    private enum ChannelDisclosure {
        static func facts(for channel: MarketplaceChannel) -> [String] {
            let label = channel.label
            var facts: [String]
            switch channel.tier {
            case .api:
                facts = [
                    "GradeThread connects to \(label) through its authorized developer API, under \(label)'s own developer terms.",
                    "You grant access by signing in on \(label) itself. GradeThread holds a revocable access token, never your password.",
                    "\(label) sees GradeThread as the registered application it approved, so this is a sanctioned integration rather than automation of your session.",
                ]
            case .listingKit:
                facts = [
                    "\(label)'s terms restrict third-party automation. Plenty of sellers use tools like this one, and \(label) can still limit an account it decides is automated.",
                    "The actions run in your own browser, in the \(label) tab you are already signed in to. Nothing about \(label) runs on GradeThread's servers.",
                    "GradeThread's servers never receive your \(label) password or session cookie.",
                    "Your account, your responsibility. If \(label) limits it, GradeThread cannot appeal on your behalf.",
                ]
            case .comingSoon:
                facts = [
                    "GradeThread does not connect to \(label). Nothing is automated and nothing about your \(label) account is linked.",
                ]
            }
            if let note = note(for: channel.id) { facts.append(note) }
            return facts
        }

        private static func note(for id: String) -> String? {
            switch id {
            case "poshmark":
                return "Sharing, following and sending offers are capped and metered, and the extension shows how much of today's cap you have used. Going past what Poshmark tolerates puts a closet in share jail, where shares stop reaching buyers."
            case "grailed":
                // 2026-08-11: permanent, not a gap awaiting a fix. Grailed
                // confirms a delete with a native browser dialog, which nothing
                // running in a page can answer. The seller has to know before
                // they cross-list, not after something sells.
                return "Grailed listings have to be ended by hand. Grailed confirms a delete with a browser pop-up that no extension can answer, so when an item sells somewhere else GradeThread flags the Grailed copy and reminds you \u{2014} it cannot close it for you."
            case "vinted":
                // 2026-08-11: listing is on, delisting is not yet. Same words as
                // the web disclosure, and said before the seller cross-lists.
                return "Vinted is EU-first. The flow runs on the country domains the extension covers and reports \u{201C}list manually\u{201D} on any other rather than guessing at a form it has not seen. Vinted listings have to be ended by hand for now \u{2014} when an item sells somewhere else GradeThread flags the Vinted copy and reminds you, but it cannot close it for you yet."
            case "facebook":
                return "Meta's platform terms restrict automated interaction with Marketplace. The flow only ever touches the listing form in your own signed-in session."
            default:
                return nil
            }
        }
    }

    private static let phasedChannels: [MarketplaceChannel] = [
        .init(id: "shopify", label: "Shopify", systemImage: "cart", tier: .api),
        .init(id: "poshmark", label: "Poshmark", systemImage: "bag", tier: .listingKit),
        .init(id: "mercari", label: "Mercari", systemImage: "shippingbox", tier: .listingKit),
        .init(id: "grailed", label: "Grailed", systemImage: "tag", tier: .listingKit),
        .init(id: "depop", label: "Depop", systemImage: "tshirt", tier: .listingKit),
        // Whatnot was previously shown with a "Coming soon" badge. App Review
        // reads such copy literally and can flag a non-shipping feature, so it's
        // omitted until it has a real integration. The `.comingSoon` tier is kept
        // for when a future channel needs to be staged again.
    ]

    // US-2481: queued extension work, and what never ran.
    //
    // Two lists, deliberately. `pending` is honest waiting. `needsAttention` is
    // work that expired without a desktop browser ever opening — and that half
    // is the one that earns the section: a seller who believes a delist is still
    // pending is a seller heading for a double sale, so it surfaces here rather
    // than aging out in silence.
    @ViewBuilder
    private var extensionQueueSection: some View {
        if !queuePending.isEmpty || !queueNeedsAttention.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("Queued for your desktop")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, alignment: .leading)

                if !queuePending.isEmpty {
                    // The wording comes from the service, not from this view, so
                    // web and iOS cannot drift into saying different things about
                    // whether the work has happened.
                    Text(ExtensionQueueService.queuedNotice)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    ForEach(queuePending) { job in
                        HStack(spacing: 10) {
                            Image(systemName: "clock")
                                .scaledIconFont(size: 15, maxSize: 24)
                                .foregroundStyle(.secondary)
                            Text(Self.describe(job))
                                .font(.subheadline)
                                .foregroundStyle(.primary)
                            Spacer()
                            Button("Cancel") {
                                Task { await cancelQueued(job.id) }
                            }
                            .font(.caption.weight(.semibold))
                            .buttonStyle(.plain)
                            .foregroundStyle(Color.brandRed)
                        }
                        .padding(12)
                        .cardStyle(.flush)
                    }
                }

                if !queueNeedsAttention.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Didn't run")
                            .font(.subheadline.weight(.semibold))
                        Text("These waited for a desktop browser that never opened, or failed when they ran. Nothing happened on the marketplace — do it there yourself, or queue it again.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        ForEach(queueNeedsAttention) { job in
                            Text("• \(Self.describe(job))")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .padding(12)
                    .cardStyle(.flush)
                }
            }
        }
    }

    // US-2481 AC1: sold elsewhere, still live here.
    //
    // The order of the two buttons is the argument. "Queue for my desktop" is
    // first because it is the one that actually ends the listing, and its
    // caption is the same sentence every other surface uses — a seller must
    // never leave this screen believing the listing is already down. "I ended
    // it myself" is second and is the ONLY thing that clears the stamp without
    // the extension, because a stamp cleared on a listing that is still live is
    // precisely the double sale this queue exists to prevent.
    @ViewBuilder
    private var pendingDelistSection: some View {
        if !pendingDelists.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("Sold elsewhere, still listed")
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text("These sold on another channel. They're still up here until something ends them, so a second buyer can still pay for them.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)

                ForEach(pendingDelists) { row in
                    pendingDelistRow(row)
                }

                if let message = delistMessage {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    @ViewBuilder
    private func pendingDelistRow(_ row: PendingDelistService.PendingDelist) -> some View {
        let label = Self.phasedChannels.first { $0.id == row.platform }?.label
            ?? row.platform.capitalized
        let blocked = PendingDelistService.blockedReason(row)
        let busy = delistBusyId == row.listingId

        VStack(alignment: .leading, spacing: 8) {
            Text(row.itemTitle ?? "Untitled item")
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, alignment: .leading)
            Text("Still live on \(label)")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            if let blocked {
                // Not a failure state — it is the honest one. There is no
                // mechanism to end this from a phone, so say what there is.
                Text(blocked)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                Text(ExtensionQueueService.queuedNotice)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            HStack(spacing: 12) {
                if blocked == nil {
                    Button("Queue for my desktop") {
                        Task { await queueDelist(row) }
                    }
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.plain)
                    .foregroundStyle(Color.brandNavy)
                    .disabled(busy)
                }
                Button("I ended it myself") {
                    Task { await markDelistDone(row) }
                }
                .font(.caption.weight(.semibold))
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .disabled(busy)
                Spacer()
                if busy {
                    ProgressView().controlSize(.small)
                }
            }
        }
        .padding(12)
        .cardStyle(.flush)
    }

    private func refreshPendingDelists() async {
        do {
            pendingDelists = try await PendingDelistService.shared.pending()
        } catch {
            // Same reasoning as the queue poll: server-side state, next refresh
            // picks it up. What is NOT done here is clearing the list on a
            // failed read — a network blip must not make a live listing appear
            // to have been dealt with.
        }
    }

    private func queueDelist(_ row: PendingDelistService.PendingDelist) async {
        delistBusyId = row.listingId
        delistMessage = nil
        do {
            try await PendingDelistService.shared.queueForDesktop(row)
            delistMessage = "Queued. \(ExtensionQueueService.queuedNotice)"
            await refreshQueue()
        } catch {
            delistMessage = error.localizedDescription
        }
        delistBusyId = nil
    }

    private func markDelistDone(_ row: PendingDelistService.PendingDelist) async {
        delistBusyId = row.listingId
        delistMessage = nil
        do {
            try await PendingDelistService.shared.markEndedManually(listingId: row.listingId)
            pendingDelists.removeAll { $0.listingId == row.listingId }
        } catch {
            delistMessage = "Couldn't clear that. It's still marked as needing to be ended."
        }
        delistBusyId = nil
    }

    private static func describe(_ job: ExtensionQueueService.QueueItem) -> String {
        let label = phasedChannels.first { $0.id == job.platform }?.label
            ?? job.platform.capitalized
        // No `share` case: US-2497 removed the kind and deleted its rows, because
        // a share run needs a human at the browser and a queue cannot supply one.
        switch job.kind {
        case "delist": return "End the \(label) listing"
        default:       return "List to \(label)"
        }
    }

    private func refreshQueue() async {
        do {
            let snapshot = try await ExtensionQueueService.shared.snapshot()
            queuePending = snapshot.pending
            queueNeedsAttention = snapshot.needsAttention
        } catch {
            // A failed poll is not worth an alert: the queue is server-side
            // state and the next refresh picks it up. Showing an error here
            // would train the seller to dismiss this section.
            queuePending = []
            queueNeedsAttention = []
        }
    }

    private func cancelQueued(_ id: String) async {
        try? await ExtensionQueueService.shared.cancel(id: id)
        await refreshQueue()
    }

    private var comingSoonChannelsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("More channels")
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, alignment: .leading)
            Text("eBay connects right here in the app — use the card above to link a seller account. Shopify connects via API on the web dashboard. For Poshmark, Mercari, Grailed & Depop, open a drafted item and tap Listing Kit to copy each platform's tailored fields — title, description, tags, condition & category — straight into the app.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            ForEach(Self.phasedChannels) { channel in
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 12) {
                        Image(systemName: channel.systemImage)
                            .scaledIconFont(size: 18, maxSize: 28)  // US-1411
                            .foregroundStyle(.secondary)
                            .frame(width: 36, height: 36)
                            .background(Color.secondary.opacity(0.12))
                            .clipShape(RoundedRectangle(cornerRadius: CornerRadius.chip, style: .continuous))
                        Text(channel.label)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.primary)
                        Spacer()
                        Text(channel.tier.badge)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Color.brandNavy)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 3)
                            .background(Color.brandNavy.opacity(0.12))
                            .clipShape(Capsule())
                    }
                    // US-2531: a web-managed channel gets a way THERE, not
                    // just a badge saying it lives elsewhere. Only .api
                    // channels render it, so a Listing Kit row cannot pick up
                    // a link to a connection page it has no place on.
                    if case .api = channel.tier, let url = Self.webMarketplacesURL {
                        Button {
                            sheet = .webChannel(
                                WebManagedChannel(
                                    id: channel.id,
                                    label: channel.label,
                                    url: url
                                )
                            )
                        } label: {
                            Label(
                                "Connect \(channel.label) on the web",
                                systemImage: "arrow.up.forward.app"
                            )
                            .font(.caption.weight(.semibold))
                        }
                        .buttonStyle(.plain)
                        .tint(Color.brandNavy)
                        .foregroundStyle(Color.brandNavy)
                        .accessibilityLabel("Connect \(channel.label) on the web")
                        .accessibilityHint("Opens the GradeThread dashboard, where \(channel.label) is connected.")
                    }
                    // US-2475: the risk statement is on the screen, not in a
                    // README. Collapsed by default so the list stays readable,
                    // but it is one tap away and it is never absent.
                    DisclosureGroup("What this does, and what it risks") {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(ChannelDisclosure.facts(for: channel), id: \.self) { fact in
                                Text("• \(fact)")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                        .padding(.top, 6)
                    }
                    .font(.caption.weight(.medium))
                    .tint(Color.brandNavy)
                }
                .padding(12)
                .cardStyle(.flush)
                .accessibilityHint("\(channel.label), \(channel.tier.badge)")
            }
        }
    }

    // US-671: multiple eBay account management entry point.
    private func ebayAccountsCard(userId: String) -> some View {
        NavigationLink {
            EbayAccountsView(userId: userId)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "person.2.crop.square.stack")
                    .font(.title3)
                    .foregroundStyle(Color.brandNavy)
                VStack(alignment: .leading, spacing: 2) {
                    Text("eBay accounts")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("Connect, label, and switch between multiple eBay stores")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(16)
            .cardStyle(.flush)
        }
        .buttonStyle(.plain)
    }

    // US-289: photo-dump → reconcile-session intake. Scoped to the active
    // workspace owner (US-670).
    private func reconcileIntakeCard(userId: String) -> some View {
        NavigationLink {
            ReconcileIntakeView(ownerId: WorkspaceScope.tenantOwnerId(selfId: userId))
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "rectangle.stack.badge.plus")
                    .font(.title3)
                    .foregroundStyle(Color.brandNavy)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Send photos to the web board")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("Send a pile of photos to the web, where you can sort them into items")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(16)
            .cardStyle(.flush)
        }
        .buttonStyle(.plain)
    }

    // US-673: best offers + buyer messages entry point.
    private var negotiationCard: some View {
        NavigationLink {
            NegotiationInboxView()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "bubble.left.and.exclamationmark.bubble.right")
                    .font(.title3)
                    .foregroundStyle(Color.brandNavy)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Offers & messages")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("Review best offers and reply to buyers without leaving the app")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(16)
            .cardStyle(.flush)
        }
        .buttonStyle(.plain)
    }

    // US-1043/1049: returns, cancellations & payment disputes entry point.
    private var postSaleCard: some View {
        NavigationLink {
            PostSaleView()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "shield.lefthalf.filled")
                    .font(.title3)
                    .foregroundStyle(Color.brandNavy)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Returns & disputes")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("Handle returns, cancellations, and payment disputes before their deadlines")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(16)
            .cardStyle(.flush)
        }
        .buttonStyle(.plain)
    }

    // US-1046: bulk price/quantity update entry point.
    private var bulkPricingCard: some View {
        NavigationLink {
            BulkPricingView()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "tag.square")
                    .font(.title3)
                    .foregroundStyle(Color.brandNavy)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Bulk pricing")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("Update price and quantity across many eBay listings at once")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(16)
            .cardStyle(.flush)
        }
        .buttonStyle(.plain)
    }

    // US-675: AutoLister drafts library entry point.
    private var draftsCard: some View {
        NavigationLink {
            DraftsLibraryView()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "square.stack.3d.up.fill")
                    .font(.title3)
                    .foregroundStyle(Color.brandNavy)
                VStack(alignment: .leading, spacing: 2) {
                    Text("AutoLister drafts")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("Review + bulk-edit generated listings before publishing")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(16)
            .cardStyle(.flush)
        }
        .buttonStyle(.plain)
    }

    private var reconciliationCard: some View {
        NavigationLink {
            ReconciliationView()
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "arrow.left.arrow.right")
                    .scaledIconFont(size: 20, maxSize: 30)  // US-1411
                    .foregroundStyle(Color.brandAmber)
                    .frame(width: 40, height: 40)
                    .background(Color.brandAmber.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Reconciliation")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("\(orphanCount) unmatched eBay listing\(orphanCount == 1 ? "" : "s")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(16)
            .cardStyle(.flush)
        }
        .buttonStyle(.plain)
    }

    /// US-645: a failed check shows a distinct "couldn't check — tap to retry"
    /// card instead of silently hiding reconciliation as if everything matched.
    private func reconciliationErrorCard(userId: String) -> some View {
        Button {
            Task { await refreshOrphanCount(userId: userId) }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "exclamationmark.arrow.triangle.2.circlepath")
                    .scaledIconFont(size: 20, maxSize: 30)  // US-1411
                    .foregroundStyle(Color.brandAmber)
                    .frame(width: 40, height: 40)
                    .background(Color.brandAmber.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Couldn't check reconciliation")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text("Tap to retry")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "arrow.clockwise")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(16)
            .cardStyle(.flush)
        }
        .buttonStyle(.plain)
    }

    private func refreshOrphanCount(userId: String) async {
        // Lightweight count query — we only need the badge number here;
        // the full list loads when the user opens ReconciliationView.
        struct Row: Decodable { let id: String }
        do {
            let rows: [Row] = try await SupabaseShared.client
                .from("flipdesk_ebay_listings")
                .select("id")
                .eq("user_id", value: userId)
                .eq("match_status", value: "unmatched")
                .execute()
                .value
            orphanCount = rows.count
            orphanCheckFailed = false
        } catch {
            // Don't zero the count — keep the last known value and flag the
            // failure so the UI can offer a retry rather than implying zero.
            orphanCheckFailed = true
        }
    }

    // MARK: - Header

    private var headerCard: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: "antenna.radiowaves.left.and.right")
                .scaledIconFont(size: 24, maxSize: 36)  // US-1411
                .foregroundStyle(Color.brandNavy)
                .frame(width: 48, height: 48)
                .background(Color.brandNavy.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text("Connected accounts")
                    .font(.brandHeadline)
                Text("Manage where your items sell.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(16)
        .cardStyle(.flush)
    }

    // MARK: - eBay card

    @ViewBuilder
    private func connectionCard(userId: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("eBay")
                    .font(.brandTitle2)
                Spacer()
                statusPill
            }

            switch store.phase {
            case .loading:
                // US-692: skeleton the connection panel instead of a bare spinner.
                VStack(alignment: .leading, spacing: 10) {
                    SkeletonLine(widthFraction: 0.5, height: 14)
                    SkeletonLine(widthFraction: 0.7, height: 12)
                    SkeletonBlock(cornerRadius: CornerRadius.control).frame(height: 38)
                }
                .accessibilityLabel("Checking connection")
            case .disconnected:
                disconnectedBody(userId: userId)
            case .connected(let conn):
                connectedBody(connection: conn, userId: userId)
            case .reconnectRequired(let conn, let message):
                reconnectBody(connection: conn, message: message, userId: userId)
            case .failed(let message):
                failedBody(message: message, userId: userId)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .cardStyle(.flush)
    }

    // MARK: - Card bodies

    private func disconnectedBody(userId: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Connect your eBay seller account to push listings, sync orders, and reconcile payouts from this app.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            connectButton(userId: userId, label: "Connect eBay account")
        }
    }

    private func connectedBody(
        connection: RemoteMarketplaceConnection,
        userId: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let handle = connection.accountHandle {
                Label("Signed in as \(handle)", systemImage: "person.crop.circle.badge.checkmark")
                    .font(.subheadline)
            }
            if let last = connection.lastSyncedAt {
                Label("Last sync \(humanRelative(last))", systemImage: "clock")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                Label("Hasn't synced yet — first pull starts soon.", systemImage: "clock")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            HStack(spacing: 10) {
                Button {
                    AppRouter.haptic()
                    syncTask?.cancel()
                    syncTask = Task { await runSync(userId: userId) }
                } label: {
                    HStack(spacing: 4) {
                        if isSyncing {
                            ProgressView().tint(.white)
                        } else {
                            Image(systemName: "arrow.triangle.2.circlepath")
                        }
                        Text(isSyncing ? "Syncing…" : "Sync now")
                    }
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 14)
                    .frame(minHeight: 44)  // US-1411: 44pt tap target
                    .background(Color.brandNavy)
                    .foregroundStyle(.white)
                    .clipShape(Capsule())
                }
                // US-1189: don't let a second tap spawn a duplicate sync run.
                .disabled(isSyncing)

                connectButton(userId: userId, label: "Reconnect")
                Button(role: .destructive) {
                    // US-1189: confirm before tearing down the connection
                    // (mirrors the multi-account screen).
                    confirmingDisconnect = true
                } label: {
                    Text("Disconnect")
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 14)
                        .frame(minHeight: 44)  // US-1411: 44pt tap target
                        .background(Color.brandRed.opacity(0.1))
                        .foregroundStyle(Color.brandRed)
                        .clipShape(Capsule())
                }
            }
            .padding(.top, 4)
        }
        .confirmationDialog(
            "Disconnect eBay?",
            isPresented: $confirmingDisconnect,
            titleVisibility: .visible
        ) {
            Button("Disconnect", role: .destructive) {
                Task { await store.disconnect(userId: userId) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This stops syncing and publishing until you reconnect.")
        }
    }

    private func runSync(userId: String) async {
        // US-1189: mark the button busy for the whole run so a second tap can't
        // start a duplicate sync.
        isSyncing = true
        defer { isSyncing = false }
        // Show the modal up front so the rotating-stage UI starts
        // before the network call returns.
        syncStore.beginSync()
        sheet = .sync

        let service = EbaySyncService(container: modelContext.container, syncEngine: syncEngine)
        let baseline = await service.snapshot(userId: userId)
        let completion = await service.sync(userId: userId, baseline: baseline)
        // Modal dismissed mid-sync — the task was cancelled; don't apply a
        // result over the reset store or fire feedback for a sync the user left.
        if Task.isCancelled { return }
        syncStore.apply(completion)
        // US-195: feedback that mirrors the completion outcome.
        switch completion {
        case .completed:           HapticFeedback.success()
        case .timedOut:            HapticFeedback.warning()
        case .connectionFlagged,
             .failed:              HapticFeedback.error()
        }

        // Refresh the connection card so the "last synced" line catches up.
        await store.refresh(userId: userId)
    }

    /// Cancels an in-flight sync poll and resets the modal store. Called when
    /// the sync sheet is dismissed (US-1007).
    private func cancelSync() {
        syncTask?.cancel()
        syncTask = nil
        syncStore.reset()
    }

    private func reconnectBody(
        connection: RemoteMarketplaceConnection,
        message: String,
        userId: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(
                "eBay flagged this connection — token refresh failed.",
                systemImage: "exclamationmark.triangle.fill"
            )
            .foregroundStyle(.brandAmber)
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
            connectButton(userId: userId, label: "Reconnect eBay")
        }
    }

    private func failedBody(message: String, userId: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(message, systemImage: "exclamationmark.triangle")
                .font(.subheadline)
                .foregroundStyle(.red)
            connectButton(userId: userId, label: "Try again")
        }
    }

    // MARK: - Reusable bits

    private func connectButton(userId: String, label: String) -> some View {
        Button {
            AppRouter.haptic()
            Task { await store.connect(userId: userId) }
        } label: {
            HStack(spacing: 6) {
                if store.isConnecting { ProgressView().tint(.white) }
                Text(label).font(.subheadline.weight(.semibold))
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 44)  // US-1411: 44pt tap target
            .background(Color.brandNavy)
            .foregroundStyle(.white)
            .clipShape(Capsule())
        }
        .disabled(store.isConnecting)
    }

    private var statusPill: some View {
        Group {
            switch store.phase {
            case .connected:
                pill(text: "Connected", color: .brandEmerald)
            case .reconnectRequired:
                pill(text: "Reconnect required", color: .brandAmber)
            case .disconnected:
                pill(text: "Setup required", color: .secondary)
            case .loading:
                pill(text: "—", color: .secondary)
            case .failed:
                // US-1189: a failed check shouldn't read as the neutral loading
                // placeholder — it has an error body + retry below.
                pill(text: "Error", color: .brandRed)
            }
        }
    }

    private func pill(text: String, color: Color) -> some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.12))
            .clipShape(Capsule())
    }

    /// Cached ISO-8601 parsers. Allocating an `ISO8601DateFormatter` is
    /// expensive and `humanRelative` runs on every row render, so we reuse a
    /// shared pair instead of building two per call (US-1226, mirrors the
    /// US-1007 fix in `EbaySyncService`). These only PARSE, so no fractional-
    /// seconds-writing variant is needed.
    private static let isoFull: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain = ISO8601DateFormatter()

    private func humanRelative(_ iso: String) -> String {
        guard let date = Self.isoFull.date(from: iso) ?? Self.isoPlain.date(from: iso) else {
            return "recently"
        }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: .now)
    }

    private func currentUserId() -> String? {
        if case let .signedIn(user) = authStore.phase {
            return user.id.uuidString
        }
        return nil
    }

    /// US-1262: if a "reconnect eBay" deep link is pending, start the OAuth flow.
    /// Guards run BEFORE consuming the latch so a not-yet-ready state (signed out,
    /// already connecting) doesn't silently swallow the request.
    private func consumeReconnectRequest() {
        guard let userId = currentUserId(), !store.isConnecting else { return }
        guard EbayReconnectLatch.shared.consume() else { return }
        Task { await store.connect(userId: userId) }
    }
}
