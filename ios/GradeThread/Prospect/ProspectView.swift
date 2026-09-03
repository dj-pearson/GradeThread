import SwiftUI
import PhotosUI
import SwiftData

/// Item Prospecting (US-1107): the in-store "should I buy this?" scan. Snap the
/// front + the brand/size tag and the app identifies the item, counts how many
/// comps are out there, shows the going rate, and forecasts how fast it sells —
/// no typing required. Optionally enter what you'd pay for a buy/skip verdict.
struct ProspectView: View {
    let router: AppRouter

    // US-1180: @Observable store via @State (was @StateObject/ObservableObject).
    @State private var store = ProspectStore()
    @Environment(\.dismiss) private var dismiss
    // US-3100: the sourcing log. Prospect answered "is this worth buying" and
    // then threw the answer away when the sheet closed, so a seller who wanted
    // to go back to the one they passed on had to re-scan it — a second metered
    // AI action for an answer we already had.
    @Environment(\.modelContext) private var modelContext
    @Environment(AuthStore.self) private var authStore
    /// The saved row this session wrote, so an add can stamp it "Added".
    @State private var loggedRowId: String?
    /// US-3099: ONE full-screen cover slot, two destinations. A view gets one
    /// (`check-chained-sheets`), and chaining a second is undefined in SwiftUI —
    /// the same lesson ``ToolModule`` records for the Home tab.
    @State private var cover: ProspectCover?

    private enum ProspectCover: String, Identifiable {
        case camera
        case barcode
        var id: String { rawValue }
    }

    @State private var showLibrary = false
    /// US-2923: which named slot the next captured photo fills. Set before the
    /// picker opens, because the picker's callback has no way to know which slot
    /// was tapped and a wrong role is worse than a missing photo.
    @State private var pendingRole: ProspectPhotoRole = .front
    // US-1225: surface a library pick that fails to load instead of a silent
    // no-op (mirrors Snap's loadError pattern from US-1181).
    @State private var loadError: String?
    // ── US-3099: the on-device reading ──────────────────────────────────────
    /// The chip being corrected, if any. One alert rather than one per chip:
    /// a view gets one alert slot, the same reason ``ToolModule`` exists.
    @State private var editingChipTitle: String?
    @State private var editingChipValue: String = ""
    @State private var editingChipCommit: ((String) -> Void)?


    private var cameraAvailable: Bool {
        UIImagePickerController.isSourceTypeAvailable(.camera)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Snap the item, and its tag if it has one. We'll identify it and pull eBay comps: how many are listed, what they're asking, and how fast it should move. Got the wrong item? Tap the title to fix it.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)

                    photoStrip
                    captureButtons
                    onDeviceHints
                    costField

                    Button {
                        AppRouter.haptic()
                        Task { await store.run() }
                    } label: {
                        if store.isLoading {
                            ProgressView().frame(maxWidth: .infinity)
                        } else {
                            // US-1225: once a result exists, entering/changing the
                            // cost needs a re-run for the verdict (ROI is computed
                            // server-side), so relabel the CTA to invite it.
                            Label(store.costNeedsRerun ? "Re-run for buy / skip verdict" : "Find comps",
                                  systemImage: store.costNeedsRerun ? "arrow.clockwise" : "magnifyingglass")
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(.brandPrimary)
                    .disabled(!store.canRun)

                    if let message = store.errorMessage {
                        // US-1163: offer a retry instead of a dead-end red line.
                        VStack(alignment: .leading, spacing: 8) {
                            Text(message)
                                .font(.footnote)
                                .foregroundStyle(Color.brandRed)
                            Button("Try again") { Task { await store.run() } }
                                .font(.footnote.weight(.semibold))
                                .buttonStyle(.bordered)
                                .disabled(!store.canRun)
                        }
                    }

                    if let result = store.result {
                        resultCard(result)
                    } else if let saved = store.restored {
                        savedCard(saved)
                    }
                }
                .padding()
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Prospect")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                // US-1866: Thrift Radar lives inside Prospect because it answers
                // the question one step BEFORE a scan — "is this store worth
                // walking into?" — off the scans this same screen produces.
                // Opening it enrols nobody: viewing and contributing are
                // separate consents.
                ToolbarItem(placement: .primaryAction) {
                    NavigationLink {
                        RadarNearbyView()
                    } label: {
                        Label("Nearby", systemImage: "dot.radiowaves.left.and.right")
                    }
                }
            }
            // US-2923: one photo at a time, into the slot the seller tapped.
            // `selectionLimit: 1` rather than the old "however many are free"
            // because a photo now lands in a NAMED role, and a multi-pick would
            // have to guess which role each of them filled.
            .sheet(isPresented: $showLibrary) {
                PhotoLibraryPicker(selectionLimit: 1) { results in
                    showLibrary = false
                    let role = pendingRole
                    Task {
                        guard let first = results.first else { return }
                        if let img = await first.loadImage() {
                            await MainActor.run { store.setImage(img, for: role) }
                        } else {
                            // US-1225: don't silently swallow a failed load.
                            await MainActor.run {
                                loadError = "Couldn't load that photo — it may still be downloading from iCloud. Try again or pick another."
                            }
                        }
                    }
                }
                .ignoresSafeArea()
            }
            .fullScreenCover(item: $cover) { which in
                switch which {
                case .camera:
                    CameraPicker { img in store.setImage(img, for: pendingRole) }
                        .ignoresSafeArea()
                case .barcode:
                    // US-3099: the EXISTING Vision-based scanner (US-179), not a
                    // second AVCaptureMetadataOutput path. `ProspectBarcode`
                    // narrows what it accepts — that scanner also reads Code 128
                    // and QR, which are thrift SKU stickers and seller batch
                    // tags, and neither identifies a product in any catalogue we
                    // can query.
                    BarcodeScanView { payload in
                        store.acceptBarcode(payload)
                    }
                    .ignoresSafeArea()
                }
            }
            .alert(
                "Couldn't load photo",
                isPresented: Binding(get: { loadError != nil }, set: { if !$0 { loadError = nil } })
            ) {
                Button("OK") { loadError = nil }
            } message: {
                Text(loadError ?? "")
            }
            // US-3099: correcting a chip. An alert rather than a second sheet —
            // the view's one sheet and one cover are already spent, and a
            // one-field correction does not want a screen.
            .alert(
                editingChipTitle ?? String(localized: "Correct"),
                isPresented: Binding(
                    get: { editingChipTitle != nil },
                    set: { if !$0 { editingChipTitle = nil } }
                )
            ) {
                TextField("", text: $editingChipValue)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                Button("Save") {
                    editingChipCommit?(editingChipValue)
                    editingChipTitle = nil
                }
                Button("Cancel", role: .cancel) { editingChipTitle = nil }
            } message: {
                Text(String(localized: "What does the tag actually say? Your correction is used as-is."))
            }
            // ── US-3100: the sourcing log ───────────────────────────────────
            .onAppear(perform: restoreIfRequested)
            .onChange(of: store.resultToken) { _, _ in recordResult() }
            .onChange(of: store.addedItemId) { _, itemId in
                guard let itemId, let rowId = loggedRowId ?? store.restored?.id else { return }
                log?.markAdded(rowId: rowId, itemId: itemId)
            }
        }
    }

    // MARK: - US-3100: remembering the verdict

    /// The log for the signed-in tenant, or nil when there is no session to
    /// scope it to. Nil is a no-op everywhere rather than an error: a seller
    /// whose session lapsed mid-scan should lose the note, not the scan.
    private var log: ProspectLog? {
        guard case let .signedIn(user) = authStore.phase else { return nil }
        return ProspectLog(
            context: modelContext,
            userId: WorkspaceScope.tenantOwnerId(selfId: user.id.uuidString)
        )
    }

    private func recordResult() {
        guard let result = store.result, let log else { return }
        // The FRONT photo, falling back to the tag. A thumbnail of a care label
        // is a poor row, but a row with no picture at all is worse — the seller
        // recognises the garment before they read the title.
        loggedRowId = log.record(result, thumbnail: store.itemPhoto ?? store.tagPhoto)
    }

    /// Reopen a verdict the seller tapped on Home.
    ///
    /// Cleared as it is read, the same way ``AppRouter/pendingToolModule`` is:
    /// otherwise every return from the background reopens the same saved row
    /// over whatever the seller is scanning now.
    private func restoreIfRequested() {
        guard let rowId = router.pendingProspectResultId else { return }
        router.pendingProspectResultId = nil
        guard let row = log?.row(id: rowId) else { return }
        store.restore(row)
        loggedRowId = row.id
    }

    // MARK: - Capture

    /// US-2923: two NAMED slots, not a strip of interchangeable photos.
    ///
    /// The slot the seller fills is what the server is told the photo shows, and
    /// that single fact decides whether it reads the tag or runs eBay visual
    /// search. Both slots are optional and either alone is a valid scan.
    private var photoStrip: some View {
        HStack(spacing: 10) {
            ForEach(ProspectPhotoRole.allCases, id: \.self) { role in
                photoSlot(role)
            }
        }
    }

    @ViewBuilder private func photoSlot(_ role: ProspectPhotoRole) -> some View {
        let image = store.image(for: role)
        VStack(alignment: .leading, spacing: 4) {
            ZStack {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                } else {
                    RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous)
                        .fill(Color.secondary.opacity(0.1))
                        .overlay {
                            VStack(spacing: 6) {
                                Image(systemName: role.systemImage).font(.system(size: 28))
                                Text(role.hint)
                                    .font(.caption2)
                                    .multilineTextAlignment(.center)
                            }
                            .foregroundStyle(.secondary)
                            .padding(8)
                        }
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 190)
            .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
            .onTapGesture {
                guard image == nil else { return }
                AppRouter.haptic()
                pendingRole = role
                if cameraAvailable { cover = .camera } else { showLibrary = true }
            }
            .overlay(alignment: .topTrailing) {
                if image != nil {
                    Button {
                        AppRouter.haptic()
                        store.removeImage(for: role)
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.title3)
                            .foregroundStyle(.white, .black.opacity(0.5))
                    }
                    .accessibilityLabel(Text("Remove \(role.label)"))
                    .padding(6)
                }
            }
            .accessibilityLabel(Text(image == nil ? "Add \(role.label)" : role.label))

            Text(role.label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(image == nil ? Color.secondary : Color.brandNavy)
        }
    }

    @ViewBuilder private var captureButtons: some View {
        if store.canAddPhoto {
            // The buttons fill the FIRST empty slot, so tapping a slot and
            // tapping a button lead to the same place. Without this the buttons
            // would need a role of their own and the two paths could disagree.
            let target = ProspectPhotoRole.allCases.first { store.image(for: $0) == nil }
            HStack(spacing: 10) {
                if cameraAvailable {
                    Button {
                        AppRouter.haptic()
                        if let target { pendingRole = target }
                        cover = .camera
                    } label: {
                        Label("Take photo", systemImage: "camera.fill").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
                Button {
                    AppRouter.haptic()
                    if let target { pendingRole = target }
                    showLibrary = true
                } label: {
                    Label("Library", systemImage: "photo.on.rectangle").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
            .tint(Color.brandNavy)

            // US-3099: shoes and sealed goods carry a barcode, which is a
            // checksummed product id rather than a reading — the strongest
            // identification available, and it needs no photo of a tag at all.
            if cameraAvailable {
                Button {
                    AppRouter.haptic()
                    cover = .barcode
                } label: {
                    Label(
                        store.scannedBarcode == nil
                            ? String(localized: "Scan a barcode")
                            : String(localized: "Scan again"),
                        systemImage: "barcode.viewfinder"
                    )
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(Color.brandNavy)
            }
        }
    }

    // ── US-3099: what the phone read, before anything was uploaded ──────────

    /// The brand and size chips, editable, plus the scanned barcode.
    ///
    /// Shown only when there is something to show. An empty row of placeholder
    /// chips would suggest the reading failed when in fact no tag was taken.
    @ViewBuilder private var onDeviceHints: some View {
        if store.isReadingTag {
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text(String(localized: "Reading the tag\u{2026}"))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else if !store.outgoingHints.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                if let barcode = store.scannedBarcode {
                    Label(String(localized: "Barcode \(barcode)"), systemImage: "barcode.viewfinder")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Color.brandEmerald)
                }
                HStack(spacing: 8) {
                    hintChip(
                        title: String(localized: "Brand"),
                        value: store.hints.brand,
                        onEdit: { store.editHints(brand: $0, size: store.hints.size) }
                    )
                    hintChip(
                        title: String(localized: "Size"),
                        value: store.hints.size,
                        onEdit: { store.editHints(brand: store.hints.brand, size: $0) }
                    )
                }
                // Said plainly because it is the seller's own saving: a
                // confident read means the server does not spend an AI action
                // re-reading the tag they just photographed.
                Text(TagHintParser.willSkipServerIdentify(store.outgoingHints)
                     ? String(localized: "Read on your phone \u{2014} no AI charge to identify it.")
                     : String(localized: "Tap to correct either one. A correction is used as-is."))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder private func hintChip(
        title: String,
        value: String?,
        onEdit: @escaping (String) -> Void
    ) -> some View {
        if let value, !value.isEmpty {
            Button {
                AppRouter.haptic()
                editingChipTitle = title
                editingChipValue = value
                editingChipCommit = onEdit
            } label: {
                HStack(spacing: 4) {
                    Text(title).foregroundStyle(.secondary)
                    Text(value).fontWeight(.semibold)
                    Image(systemName: "pencil").font(.caption2).foregroundStyle(.tertiary)
                }
                .font(.caption)
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background(Color.brandNavy.opacity(0.10), in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("\(title): \(value). Tap to correct."))
        }
    }

    private var costField: some View {
        // US-1180: @Bindable yields a two-way binding from the @Observable store.
        @Bindable var store = store
        return VStack(alignment: .leading, spacing: 4) {
            TextField("What would you pay? (optional)", text: $store.costText)
                .keyboardType(.decimalPad)
                .textFieldStyle(.roundedBorder)
                // US-1522: decimalPad has no return key — add a Done toolbar so the
                // keyboard can be dismissed (matches the other numeric fields).
                .keyboardDoneToolbar()
            if store.costNeedsRerun {
                // US-1225: the verdict is server-computed for the cost it ran with,
                // so a cost entered/changed after a run needs a re-run to take.
                Text("Re-run to apply this cost to the buy / skip verdict.")
                    .font(.caption2)
                    .foregroundStyle(Color.brandAmber)
            } else {
                Text("Enter your cost for a buy / skip verdict and ROI.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Result

    @ViewBuilder private func resultCard(_ result: ProspectResponse) -> some View {
        if !result.identified {
            VStack(alignment: .leading, spacing: 8) {
                Label("Couldn't identify the item", systemImage: "questionmark.circle")
                    .font(.headline)
                Text(result.note ?? "Try a sharper photo of the brand/size tag.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: CornerRadius.control))
        } else {
            VStack(alignment: .leading, spacing: 14) {
                identityHeader(result)
                Divider()
                priceBlock(result)
                if let st = result.sellThrough, st.label != "unknown" {
                    sellThroughBlock(st, source: result.source)
                }
                if let ceiling = result.ceiling {
                    ceilingBlock(ceiling)
                }
                if let decision = result.decision, result.costCents != nil {
                    decisionBlock(decision)
                }
                soldCompsLinks(result)
                if let disclaimer = result.disclaimer {
                    Text(disclaimer)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.brandAmber.opacity(0.12), in: RoundedRectangle(cornerRadius: CornerRadius.chip))
                }
                addToInventoryButton
            }
            .padding()
            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: CornerRadius.control))
        }
    }

    /// US-3100: a verdict reopened from the log.
    ///
    /// Deliberately a DIFFERENT card from ``resultCard``, showing only what was
    /// saved. The temptation was to rebuild a `ProspectResponse` from the row
    /// and reuse the live card, and that would put "0 comps", "unknown
    /// sell-through" and a missing disclaimer on screen beside a real price —
    /// numbers the server never returned, presented as though it had.
    @ViewBuilder private func savedCard(_ row: LocalProspectResult) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                savedThumbnail(row)
                VStack(alignment: .leading, spacing: 4) {
                    Text(row.displayTitle)
                        .font(.headline)
                    if let brand = row.brand, !brand.isEmpty {
                        Text(brand)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    Text(row.createdAt, format: .relative(presentation: .named))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                if let decision = row.decision {
                    Text(ProspectDecisionCopy.label(decision))
                        .font(.caption.weight(.bold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(
                            recommendationColor(decision).opacity(0.15),
                            in: Capsule()
                        )
                        .foregroundStyle(recommendationColor(decision))
                }
            }

            Divider()

            metricRow(String(localized: "Going rate"), dollars(row.medianCents))
            if row.lowCents != nil || row.highCents != nil {
                metricRow(
                    String(localized: "Range"),
                    "\(dollars(row.lowCents)) – \(dollars(row.highCents))"
                )
            }
            if let ceiling = row.ceilingCents {
                metricRow(String(localized: "Pay up to"), dollars(ceiling))
            }
            if let grade = row.gradeValue {
                metricRow(
                    String(localized: "Condition"),
                    row.gradeTier.map { "\(String(format: "%.1f", grade)) · \($0)" }
                        ?? String(format: "%.1f", grade)
                )
            }

            // The numbers are from the scan, not from now. Saying so is the
            // difference between a saved note and a stale price the seller
            // believes is live.
            Text(String(localized: "Saved from your scan. Prices move — re-scan the item for today's numbers."))
                .font(.caption2)
                .foregroundStyle(.secondary)

            addToInventoryButton
        }
        .padding()
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: CornerRadius.control))
    }

    @ViewBuilder private func savedThumbnail(_ row: LocalProspectResult) -> some View {
        if let data = row.thumbnailData, let image = UIImage(data: data) {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: CornerRadius.chip, style: .continuous))
        } else {
            RoundedRectangle(cornerRadius: CornerRadius.chip, style: .continuous)
                .fill(Color.secondary.opacity(0.15))
                .frame(width: 56, height: 56)
                .overlay {
                    Image(systemName: "tshirt").foregroundStyle(.secondary)
                }
        }
    }

    /// US-3026: the sold-comps links, with the search terms visible.
    ///
    /// The old row was one link labelled "See sold comps on eBay" and nothing
    /// else. When the identification was thin it opened the completed search for
    /// the brand alone — every We The Free garment ever listed, next to an
    /// estimate for one cropped top — and there was nothing on screen to say so.
    /// The seller had to notice on eBay's page, which is late.
    ///
    /// So the terms are printed under the link, and there is a second link that
    /// drops back to brand-plus-type. Two links because neither of us can tell
    /// in advance which garment eBay has ten of: a five-word search is right
    /// until it returns an empty page, and an empty sold page reads as "nothing
    /// like this ever sold".
    @ViewBuilder private func soldCompsLinks(_ result: ProspectResponse) -> some View {
        if let url = EbayOutboundURL.resolve(url: result.ebaySoldSearchUrl, fallback: nil) {
            VStack(alignment: .leading, spacing: 4) {
                // US-3097: `EbayOutboundLink`, not `Link`. A SwiftUI Link lands
                // in an in-app browser; only UIApplication.open hands an
                // ebay.com universal link to the installed eBay app, which is
                // where the seller is already signed in.
                EbayOutboundLink(url: url, surface: "prospect_sold_comps") {
                    Label(String(localized: "See sold comps on eBay"), systemImage: "arrow.up.right.square")
                        .font(.footnote.weight(.medium))
                }
                .tint(Color.brandNavy)

                if let terms = result.ebaySoldSearchQuery, !terms.isEmpty {
                    Text("Searching: \(terms)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .accessibilityLabel(Text("Sold comps search terms: \(terms)"))
                }

                if let broadURL = EbayOutboundURL.resolve(url: result.ebayBroadSearchUrl, fallback: nil) {
                    EbayOutboundLink(url: broadURL, surface: "prospect_broad_comps") {
                        Label(
                            result.ebayBroadSearchQuery
                                .map { String(localized: "Too few results? Search \($0)") }
                                ?? String(localized: "Too few results? Search wider"),
                            systemImage: "arrow.up.left.and.arrow.down.right"
                        )
                        .font(.caption2)
                        .lineLimit(2)
                    }
                    .tint(.secondary)
                }
            }
        }
    }

    /// US-2923: the correction field, shown in place of the title while editing.
    ///
    /// The whole point is speed — the seller is standing in an aisle holding the
    /// garment — so it opens prefilled with the current title, the keyboard's
    /// return key runs the re-pull, and nothing else on the card moves.
    @ViewBuilder private func titleEditor(_ draft: String) -> some View {
        @Bindable var store = store
        VStack(alignment: .leading, spacing: 8) {
            TextField(
                "What is it really?",
                text: Binding(
                    get: { store.titleDraft ?? draft },
                    set: { store.titleDraft = $0 }
                )
            )
            .textFieldStyle(.roundedBorder)
            .textInputAutocapitalization(.words)
            .autocorrectionDisabled()
            .submitLabel(.search)
            .onSubmit { Task { await store.repull() } }

            HStack(spacing: 10) {
                Button {
                    AppRouter.haptic()
                    Task { await store.repull() }
                } label: {
                    if store.isRepulling {
                        ProgressView().frame(maxWidth: .infinity)
                    } else {
                        Label("Re-pull comps", systemImage: "arrow.clockwise")
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.brandNavy)
                .disabled(!store.canRepull)

                Button("Cancel") { store.cancelTitleEdit() }
                    .buttonStyle(.bordered)
                    .disabled(store.isRepulling)
            }
            Text("Keeps your condition grade and photos. No AI charge.")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private func identityHeader(_ result: ProspectResponse) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let draft = store.titleDraft {
                titleEditor(draft)
            } else {
                Button {
                    AppRouter.haptic()
                    store.beginTitleEdit()
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(result.item.title ?? result.item.brand ?? "Item")
                            .font(.brandTitle2)
                            .multilineTextAlignment(.leading)
                        Image(systemName: "pencil")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color.brandNavy)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Edit title"))
                .accessibilityHint(Text("Correct the title and pull fresh comps"))

                // How the title was arrived at. A similarity match is worth
                // checking: US-2758 measured eBay visual search being exactly as
                // confident when it was wrong as when it was right.
                if let source = result.item.sourceLabel {
                    HStack(spacing: 4) {
                        Image(systemName: result.item.isUnverifiedGuess
                              ? "exclamationmark.triangle.fill" : "checkmark.seal")
                            .font(.caption2)
                        Text(result.item.isUnverifiedGuess
                             ? "\(source). Tap the title to correct it." : source)
                            .font(.caption2)
                    }
                    .foregroundStyle(result.item.isUnverifiedGuess
                                     ? Color.brandAmber : Color.secondary)
                }
            }
            // US-1170: show the brand the AI read off the tag so the user can
            // sanity-check the identification before committing a purchase.
            if let brand = result.item.brand, !brand.isEmpty,
               brand.caseInsensitiveCompare(result.item.title ?? "") != .orderedSame {
                Text(brand)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.brandNavy)
            }
            HStack(spacing: 8) {
                if let path = result.category?.path {
                    Text(path)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            if let grade = result.grade {
                Text("Est. grade \(String(format: "%.1f", grade.value))"
                    + (grade.tier.map { " · \($0.capitalized)" } ?? ""))
                    .font(.caption)
                    .foregroundStyle(GradeScale.color(for: grade.value))
            }
        }
    }

    /// The one-line "what is this number", when the server sent one.
    ///
    /// Renders NOTHING when there is no basis, exactly as the web component
    /// does: a value from a response built before the provenance shipped is
    /// silent rather than mislabelled.
    @ViewBuilder private func basisLine(_ basis: ValueBasis?) -> some View {
        if let basis {
            VStack(alignment: .leading, spacing: 1) {
                Text(basis.headline)
                    .font(.caption2.weight(.medium))
                if let detail = basis.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.top, 2)
        }
    }

    /// US-3097: the most to pay, which is the number a seller standing over a
    /// rack is actually trying to work out.
    ///
    /// Shown whether or not it resolved. A ceiling that is simply absent from
    /// the card teaches nothing; "we have not measured this kind of item yet"
    /// tells the seller the app is not guessing on their behalf, which is the
    /// same reason `sourcingCeiling` refuses to invent one server-side.
    @ViewBuilder private func ceilingBlock(_ ceiling: ProspectCeiling) -> some View {
        let roiPct = Int((ceiling.targetRoi * 100).rounded())
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "tag")
                .foregroundStyle(ceiling.maxPriceCents == nil ? Color.secondary : Color.brandEmerald)
            VStack(alignment: .leading, spacing: 1) {
                if let max = ceiling.maxPriceCents {
                    Text(String(localized: "Pay at most \(dollars(max)) for \(roiPct)% ROI"))
                        .font(.subheadline.weight(.semibold))
                    if let net = ceiling.netResaleCents {
                        Text(String(localized: "Net after fees at the going rate: \(dollars(net))"))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                } else if let copy = ceiling.absentCopy {
                    Text(copy)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func priceBlock(_ result: ProspectResponse) -> some View {
        if let stats = result.stats, stats.sufficient, stats.medianCents != nil {
            VStack(alignment: .leading, spacing: 2) {
                Text(dollars(stats.medianCents))
                    .font(.brandData(36, weight: .bold))
                    .foregroundStyle(Color.brandNavy)
                // US-2923: name the basis on the number itself. "Going rate" over
                // ACTIVE listings is a median of what sellers are ASKING, and
                // nothing on this card said so except a disclaimer at the bottom
                // that a seller comparing two garments in an aisle never reads.
                Text("\(result.source == "sold" ? "sold median" : "median asking price") · range \(dollars(stats.lowCents))–\(dollars(stats.highCents))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("Based on \(stats.count) condition-matched \(result.source == "sold" ? "sold" : "active") listing\(stats.count == 1 ? "" : "s")")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                // US-3097: the provenance line, in the server's words.
                //
                // The sentence is NOT written here — `headline` and `detail`
                // come phrased from lib/value-disclosure.ts, the same source the
                // web's ValueBasisNote renders, so the two clients can never
                // describe the same number differently.
                basisLine(stats.basis)
            }
        } else {
            VStack(alignment: .leading, spacing: 2) {
                Text("Not enough comps to price yet")
                    .font(.subheadline.weight(.medium))
                if let count = result.stats?.count {
                    Text("Only \(count) listing\(count == 1 ? "" : "s") found — too thin to trust.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    /// US-2923: this is a FORECAST, and the wording now says so.
    ///
    /// `sellThroughPct` is not a measured sell-through rate. lib/sell-through.ts
    /// derives it from where the price sits in the comp range; no sold data
    /// touches it, because eBay Marketplace Insights is not granted yet. The old
    /// copy read "~62% likely", which is the register of a measurement, and a
    /// seller has no way to tell that apart from one. It flips to real
    /// sell-through with no change here once `source` becomes "sold".
    private func sellThroughBlock(_ st: ProspectSellThrough, source: String) -> some View {
        let measured = source == "sold"
        return HStack(spacing: 8) {
            Image(systemName: "speedometer").foregroundStyle(sellThroughColor(st.label))
            VStack(alignment: .leading, spacing: 1) {
                Text(measured
                     ? "Sells \(st.label) · \(Int((st.sellThroughPct * 100).rounded()))% sell-through"
                     : "Likely sells \(st.label)")
                    .font(.subheadline.weight(.medium))
                Text(measured
                     ? "\(st.daysLow)–\(st.daysHigh) days at the going rate"
                     : "Rough guide only: estimated from where this price sits against active listings, not from sold data.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func decisionBlock(_ decision: ProspectDecision) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(decision.recommendation.uppercased())
                .font(.caption.weight(.bold))
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(recommendationColor(decision.recommendation).opacity(0.15),
                            in: Capsule())
                .foregroundStyle(recommendationColor(decision.recommendation))
            Text(decision.reason)
                .font(.caption)
                .foregroundStyle(.secondary)
            // US-1170: surface the ROI math the AI computed (only present once a
            // cost was entered) instead of hiding it behind the verdict.
            if decision.estProceedsCents != nil || decision.estMarginCents != nil
                || decision.roiPct != nil || decision.breakevenCents != nil {
                VStack(spacing: 2) {
                    if let p = decision.estProceedsCents { metricRow("Est. proceeds", dollars(p)) }
                    if let m = decision.estMarginCents { metricRow("Est. margin", dollars(m)) }
                    if let r = decision.roiPct { metricRow("ROI", "\(Int(r.rounded()))%") }
                    if let b = decision.breakevenCents { metricRow("Breakeven price", dollars(b)) }
                }
                .padding(.top, 2)
            }
        }
    }

    private func metricRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.caption.weight(.semibold)).monospacedDigit()
        }
    }

    @ViewBuilder private var addToInventoryButton: some View {
        if store.addedItemId != nil {
            Button {
                AppRouter.haptic()
                dismiss()
                router.selection = .inventory
            } label: {
                Label("Added — view inventory", systemImage: "checkmark.circle.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.brandSecondary)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Button {
                    AppRouter.haptic()
                    Task { await store.addToInventory() }
                } label: {
                    if store.isAdding {
                        ProgressView().frame(maxWidth: .infinity)
                    } else {
                        Label("Add to inventory", systemImage: "plus.circle.fill")
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.brandPrimary)
                .disabled(store.isAdding)

                // US-1225: add-to-inventory has its OWN error + retry, so the
                // retry re-calls addToInventory() — not the billable run() that
                // the top error card's "Try again" triggers.
                if let addError = store.addError {
                    Text(addError)
                        .font(.footnote)
                        .foregroundStyle(Color.brandRed)
                    Button("Try again") { Task { await store.addToInventory() } }
                        .font(.footnote.weight(.semibold))
                        .buttonStyle(.bordered)
                        .disabled(store.isAdding)
                }
            }
        }
    }

    // MARK: - Helpers

    private func dollars(_ cents: Int?) -> String {
        guard let cents else { return "—" }
        // US-1161: full cents + locale currency, not integer-truncated "$".
        return CurrencyFormatter.shared.formatDisplay(Double(cents) / 100)
    }

    private func sellThroughColor(_ label: String) -> Color {
        switch label {
        case "fast": return .green
        case "moderate": return Color.brandAmber
        case "slow": return Color.brandRed
        default: return .secondary
        }
    }

    /// US-3100: delegates to ``ProspectDecisionCopy`` so the saved card, the
    /// live card and the Home row cannot drift into colouring "maybe" three
    /// different ways.
    private func recommendationColor(_ rec: String) -> Color {
        ProspectDecisionCopy.color(rec)
    }
}
