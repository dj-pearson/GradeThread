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

    @State private var showingRequest = false
    @State private var showingReport = false

    private var isGraded: Bool { item.gradeValue != nil }
    private var certificateURL: URL? {
        item.certificateURL.flatMap { URL(string: $0) }
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
            Text(isGraded
                 ? "A shared certificate lets buyers verify condition before they buy — fewer “not as described” returns."
                 : "Submit this item for a standardized AI condition grade and a buyer-facing certificate.")
                .font(.caption)
        }
        .sheet(isPresented: $showingRequest) {
            GradeRequestSheet(item: item)
        }
        .sheet(isPresented: $showingReport) {
            ItemGradeReportSheet(item: item)
        }
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
                    Text("Certified condition grade")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }

            Button {
                AppRouter.haptic()
                showingReport = true
            } label: {
                Label("View full report", systemImage: "doc.text.magnifyingglass")
                    .font(.subheadline.weight(.medium))
            }

            if let certificateURL {
                ShareLink(item: certificateURL) {
                    Label("Share certificate", systemImage: "square.and.arrow.up")
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
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .listRowBackground(Color.clear)
        .listRowInsets(.init(top: 4, leading: 0, bottom: 4, trailing: 0))
    }
}

/// Loads + displays the stored report for a previously-graded item.
private struct ItemGradeReportSheet: View {
    @Environment(\.dismiss) private var dismiss
    let item: LocalInventoryItem

    @Query private var photos: [LocalItemPhoto]
    @State private var phase: Phase = .loading
    @State private var disputeTarget: DisputeTarget?

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

    /// Local photo thumbnails for the submitted-photos strip.
    private var photoURLs: [URL] {
        photos.compactMap { URL(string: $0.thumbnailURL ?? $0.photoURL) }
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
                        onDispute: GradeDisputeWindow.isOpen(createdAt: report.createdAt)
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
            .sheet(item: $disputeTarget) { target in
                DisputeSheet(gradeReportId: target.gradeReportId)
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
