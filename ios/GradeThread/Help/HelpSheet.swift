import SwiftUI

/// US-2874. The answer, on the screen the question was asked on.
///
/// The web has `HelpLink`: a question-mark button that opens the relevant
/// article beside the half-filled form the seller is stuck in. iOS had "Help &
/// FAQ" in Settings, which leaves the app -- and on a phone, leaving the app to
/// read the answer loses the thing you were doing.
///
/// ⚠️ NEVER COMPILED. Swift cannot be built on the machine this was written on
/// (no toolchain, and SwiftUI does not build on Linux at all), so iOS CI is the
/// only thing that has type-checked it. Everything below follows a pattern
/// already in the codebase for exactly that reason: `EdgeAPI.getJSON` for the
/// call, one `Identifiable` state driving one `.sheet(item:)` per
/// `ios/Scripts/check-chained-sheets.py`, and no force unwraps.

/// The `/api/help/:slug` payload. Field names match `projectArticle` in
/// `services/edge-functions/src/lib/help-center.ts`; only the fields this sheet
/// renders are decoded, so a new column on the server cannot break it.
struct HelpArticleResponse: Decodable {
    struct Article: Decodable {
        let slug: String
        let title: String
        let summary: String?
        let bodyMarkdown: String?

        enum CodingKeys: String, CodingKey {
            case slug
            case title
            case summary
            case bodyMarkdown = "body_markdown"
        }
    }

    let article: Article
}

/// What the sheet is doing right now. One value, so the view has one thing to
/// switch over rather than three booleans that can disagree.
enum HelpSheetState {
    case loading
    case loaded(HelpArticleResponse.Article)
    /// The slug has no article. The web renders NOTHING in this case (US-2618)
    /// and so does this: a help button that opens an empty sheet is worse than
    /// one that was never offered.
    case missing
    case failed(String)
}

@MainActor
final class HelpSheetModel: ObservableObject {
    @Published private(set) var state: HelpSheetState = .loading

    private let api: EdgeAPI

    init(api: EdgeAPI) {
        self.api = api
    }

    func load(_ slug: HelpSlug) async {
        state = .loading
        do {
            let response: HelpArticleResponse = try await api.getJSON(
                "/api/help/\(slug.rawValue)"
            )
            state = .loaded(response.article)
        } catch let error as EdgeAPIError {
            // A 404 is the "no article yet" case, not a failure worth an alarm.
            // The case is `.notFound(detail:)` -- EdgeAPIError carries named
            // cases, not a raw status code.
            if case .notFound = error {
                state = .missing
            } else {
                state = .failed(
                    FriendlyErrorCopy.actionMessage(
                        for: error,
                        fallback: "We couldn't open that help article."
                    )
                )
            }
        } catch {
            state = .failed(
                FriendlyErrorCopy.actionMessage(
                    for: error,
                    fallback: "We couldn't open that help article."
                )
            )
        }
    }
}

/// The question-mark button. Put it where the web puts `<HelpLink>`.
struct HelpButton: View {
    let slug: HelpSlug
    @State private var presented: PresentedHelp?

    /// One optional driving ONE `.sheet(item:)`.
    private struct PresentedHelp: Identifiable {
        let id: String
    }

    var body: some View {
        Button {
            presented = PresentedHelp(id: slug.rawValue)
        } label: {
            Image(systemName: "questionmark.circle")
        }
        .accessibilityLabel("Help for this screen")
        .sheet(item: $presented) { _ in
            HelpSheet(slug: slug)
        }
    }
}

struct HelpSheet: View {
    let slug: HelpSlug

    @Environment(\.dismiss) private var dismiss
    @StateObject private var model: HelpSheetModel

    init(slug: HelpSlug, model: HelpSheetModel? = nil) {
        self.slug = slug
        _model = StateObject(wrappedValue: model ?? HelpSheetModel(api: EdgeAPI.shared))
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Help")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
        .task { await model.load(slug) }
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded(let article):
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(article.title)
                        .font(.title3.weight(.semibold))
                    if let summary = article.summary, !summary.isEmpty {
                        Text(summary)
                            .foregroundStyle(.secondary)
                    }
                    if let body = article.bodyMarkdown, !body.isEmpty {
                        Text(body)
                            .font(.callout)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
            }
        case .missing:
            // Matches the web exactly: nothing to say, so say nothing.
            Color.clear
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .onAppear { dismiss() }
        case .failed(let message):
            ContentUnavailableView {
                Label("Couldn't load that", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            }
        }
    }
}
