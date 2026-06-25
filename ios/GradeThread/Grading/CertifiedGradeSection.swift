import SwiftData
import SwiftUI

/// The "Certified grade" section rendered inside ``ItemCanvasView``.
///
/// Two states:
///  - **Ungraded:** a prominent "Get certified grade" call-to-action that
///    opens the full request flow (``GradeRequestSheet``).
///  - **Graded:** the score chip + tier, a share-certificate button, and
///    "view full report" / "get an updated grade" actions.
struct CertifiedGradeSection: View {
    let item: LocalInventoryItem
    /// US-746: when set (item is graded and still publishable), the graded
    /// state shows a "List this item" CTA that triggers the parent's publish
    /// flow — closing the grade→list gap so they aren't two disconnected steps.
    var onListItem: (() -> Void)? = nil

    @State private var showingRequest = false
    @State private var showingReport = false
    @State private var showingDisclosure = false
    /// US-768: the graded-photo (digital slab) preview/save/share sheet.
    @State private var showingGradedPhoto = false
    /// US-1115: the Garment Passport (provenance timeline) viewer.
    @State private var showingPassport = false

    private var isGraded: Bool { item.gradeValue != nil }
    /// US-1209: a low-confidence grade is provisional (awaiting human review),
    /// so it isn't certified/shareable yet.
    private var isPendingReview: Bool { item.isGradePendingReview }
    private var certificateURL: URL? {
        // A provisional grade holds back its certificate until review clears, so
        // never resolve a share URL for one even if a stale string lingers.
        guard !isPendingReview else { return nil }
        return item.certificateURL.flatMap { URL(string: $0) }
    }

    var body: some View {
        Section {
            if isGraded, let score = item.gradeValue {
                gradedContent(score: score)
            } else {
                ungradedContent
            }
        } header: {
            Text("Certified grade")
        } footer: {
            Text(footerText)
                .font(.caption)
        }
        .sheet(isPresented: $showingRequest) {
            GradeRequestSheet(item: item)
        }
        .sheet(isPresented: $showingReport) {
            ItemGradeReportSheet(item: item)
        }
        .sheet(isPresented: $showingDisclosure) {
            DisclosureView(itemId: item.id)
        }
        .sheet(isPresented: $showingGradedPhoto) {
            if let certificateURL = item.certificateURL {
                GradedPhotoView(certificateURL: certificateURL)
            }
        }
        .sheet(isPresented: $showingPassport) {
            PassportTimelineView(inventoryItemId: item.id, itemTitle: item.title)
        }
    }

    /// US-1209: don't promise a buyer-facing certificate while a grade is still
    /// awaiting human review — it isn't shareable until it certifies.
    private var footerText: String {
        if isPendingReview {
            return "This grade's confidence was low, so a reviewer is checking it. A shareable certificate unlocks once it clears."
        }
        return isGraded
            ? "A shared certificate lets buyers verify condition before they buy — fewer “not as described” returns."
            : "Submit this item for a standardized AI condition grade and a buyer-facing certificate."
    }

    // MARK: - Graded

    private func gradedContent(score: Double) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                GradeScoreRing(score: score, tier: item.gradeLabel ?? "", diameter: 64, animateOnAppear: false)
                VStack(alignment: .leading, spacing: 3) {
                    if let label = item.gradeLabel, !label.isEmpty {
                        Text(label)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(GradeScale.color(for: score))
                    }
                    Text(isPendingReview ? "Pending human review" : "Certified condition grade")
                        .font(.caption)
                        .foregroundStyle(isPendingReview ? Color.brandAmber : .secondary)
                }
                Spacer(minLength: 0)
            }

            // US-746: a graded item's primary next action is to list it.
            if let onListItem {
                Button {
                    AppRouter.haptic()
                    onListItem()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "tag.fill")
                        Text("List this item")
                            .font(.subheadline.weight(.semibold))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(Color.brandNavy)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
                }
                .buttonStyle(.plain)
            }

            Button {
                AppRouter.haptic()
                showingReport = true
            } label: {
                Label("View full report", systemImage: "doc.text.magnifyingglass")
                    .font(.subheadline.weight(.medium))
            }

            Button {
                AppRouter.haptic()
                showingDisclosure = true
            } label: {
                Label("Defect disclosure", systemImage: "exclamationmark.bubble")
                    .font(.subheadline.weight(.medium))
            }

            // US-1115: the Garment Passport — the item's provenance timeline,
            // shareable and claimable (parity with the web trust surface).
            Button {
                AppRouter.haptic()
                showingPassport = true
            } label: {
                Label("Garment passport", systemImage: "clock.arrow.circlepath")
                    .font(.subheadline.weight(.medium))
            }

            if let certificateURL {
                ShareLink(item: certificateURL) {
                    Label("Share certificate", systemImage: "square.and.arrow.up")
                        .font(.subheadline.weight(.medium))
                }

                // US-768: the PSA-style certified "graded photo" for listings +
                // socials — preview, pick a format, save to Photos, or share.
                Button {
                    AppRouter.haptic()
                    showingGradedPhoto = true
                } label: {
                    Label("Graded photo", systemImage: "photo.badge.checkmark")
                        .font(.subheadline.weight(.medium))
                }
            }

            Button {
                AppRouter.haptic()
                showingRequest = true
            } label: {
                Label("Get an updated grade", systemImage: "arrow.triangle.2.circlepath")
                    .font(.subheadline.weight(.medium))
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: - Ungraded

    private var ungradedContent: some View {
        Button {
            AppRouter.haptic()
            showingRequest = true
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.seal.fill")
                Text("Get certified grade")
                    .font(.subheadline.weight(.semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(Color.brandNavy)
            .foregroundStyle(.white)
            .clipShape(RoundedRectangle(cornerRadius: CornerRadius.control, style: .continuous))
        }
        .listRowBackground(Color.clear)
        .listRowInsets(.init(top: 4, leading: 0, bottom: 4, trailing: 0))
    }
}

/// Loads + displays the stored report for a previously-graded item. Presented
/// from the item canvas ("View full report") and, since US-819, directly from
/// the Grades list so its dispute affordance is reachable without spelunking
/// through the canvas.
struct ItemGradeReportSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var modelContext
    let item: LocalInventoryItem

    @Query private var photos: [LocalItemPhoto]
    @State private var phase: Phase = .loading
    @State private var disputeTarget: DisputeTarget?
    /// US-979: resolved asynchronously — sensitive (private-bucket) photos
    /// need a freshly-minted signed URL rather than a permanent public one.
    @State private var photoURLs: [URL] = []

    private enum Phase: Equatable {
        case loading
        case loaded(GradeReportDTO, URL?)
        case empty
        case failed(String)
    }

    /// Identifiable wrapper so the dispute sheet can be presented via
    /// `.sheet(item:)` from a stable level.
    private struct DisputeTarget: Identifiable {
        let id = UUID()
        let gradeReportId: String
    }

    init(item: LocalInventoryItem) {
        self.item = item
        let itemId = item.id
        _photos = Query(
            filter: #Predicate<LocalItemPhoto> { $0.inventoryItemId == itemId },
            sort: \.sortOrder
        )
    }

    /// Stable signature of the photo set so the resolver re-runs only when the
    /// photos (or their storage paths) actually change.
    private var photoSignature: String {
        photos.map { "\($0.id)|\($0.photoType)|\($0.storagePath ?? "")|\($0.thumbnailURL ?? $0.photoURL)" }
            .joined(separator: ",")
    }

    /// Resolves the submitted-photos strip URLs: public photos keep their
    /// permanent URL; sensitive (private-bucket) photos get a short-TTL signed
    /// URL so the grade report can still render the care-label close-up without
    /// a permanent public URL (US-979).
    private func resolvePhotoURLs() async {
        var urls: [URL] = []
        for photo in photos {
            let bucket = PhotoStorageBucket.bucket(forServerType: photo.photoType)
            let resolved: URL?
            if bucket == PhotoStorageBucket.publicBucket {
                resolved = URL(string: photo.thumbnailURL ?? photo.photoURL)
            } else {
                resolved = await PhotoSignedURLProvider.shared.displayURL(
                    bucket: bucket,
                    storagePath: photo.storagePath,
                    publicURL: photo.thumbnailURL ?? photo.photoURL
                )
            }
            if let resolved { urls.append(resolved) }
        }
        photoURLs = urls
    }

    var body: some View {
        NavigationStack {
            Group {
                switch phase {
                case .loading:
                    GradeReportSkeleton()
                case let .loaded(report, url):
                    GradeReportView(
                        report: report,
                        certificateURL: url,
                        title: item.title,
                        photoURLs: photoURLs,
                        // US-1183: hide the dispute affordance once a dispute is
                        // already on file (optimistically set below) so the user
                        // can't immediately re-file the same dispute.
                        onDispute: (GradeDisputeWindow.isOpen(createdAt: report.createdAt)
                            && !DisputeStatusDisplay.isDisputed(item.disputeStatus))
                            ? { disputeTarget = DisputeTarget(gradeReportId: report.id) }
                            : nil
                    )
                case .empty:
                    ContentUnavailableView(
                        "Report unavailable",
                        systemImage: "doc.questionmark",
                        description: Text("We couldn't find the detailed report for this grade.")
                    )
                case let .failed(message):
                    ContentUnavailableView {
                        Label("Couldn't load report", systemImage: "wifi.exclamationmark")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("Try again") { Task { await load() } }
                            .buttonStyle(.borderedProminent)
                            .tint(Color.brandNavy)
                    }
                }
            }
            .navigationTitle("Grade report")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await load() }
            .task(id: photoSignature) { await resolvePhotoURLs() }
            .sheet(item: $disputeTarget) { target in
                DisputeSheet(gradeReportId: target.gradeReportId) {
                    // US-1183: optimistically mark the item disputed so the badge
                    // shows and the affordance is gated immediately; request a
                    // pull to reconcile with the server's authoritative status.
                    item.disputeStatus = "open"
                    item.updatedAt = .now
                    modelContext.saveOrLog("disputeFiled")
                    NotificationCenter.default.post(name: .inventoryPullRequested, object: nil)
                }
            }
        }
    }

    private func load() async {
        phase = .loading
        do {
            if let loaded = try await ItemGradeReportService.load(inventoryItemId: item.id) {
                phase = .loaded(loaded.report, loaded.certificateURL)
            } else {
                phase = .empty
            }
        } catch {
            phase = .failed((error as? EdgeAPIError)?.errorDescription ?? error.localizedDescription)
        }
    }
}
