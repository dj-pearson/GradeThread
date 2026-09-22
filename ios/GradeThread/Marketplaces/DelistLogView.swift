import SwiftUI

/// US-3452: what a sale ended, where, when and by whom, for one garment.
///
/// "Sold on eBay 14:02. Poshmark ended 14:06, your browser. Grailed: still
/// live." The same route, the same events and the same order as the web item
/// page (`src/components/flipdesk/delist-log.tsx`); the words table below
/// mirrors `src/lib/delist-log-words.ts` and changes with it.
///
/// Reached from a pending-delist row, which is where a seller asks "did the
/// others end?" A failed read says so rather than showing an empty log: an
/// empty log reads as "nothing to do", which is the one thing a network blip
/// must never say about a listing that may still be live.
struct DelistLogView: View {

    let itemId: String
    let title: String

    @Environment(\.dismiss) private var dismiss
    @State private var events: [PendingDelistService.DelistLogEvent] = []
    @State private var loading = true
    @State private var failed = false

    var body: some View {
        NavigationStack {
            List {
                if loading {
                    HStack {
                        ProgressView().controlSize(.small)
                        Text("Reading what happened")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                } else if failed {
                    Text("Couldn't read what happened after the sale. Pull to try again.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else if events.isEmpty {
                    Text("Nothing has been ended for this item yet.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(Array(events.enumerated()), id: \.offset) { _, event in
                        row(event)
                    }
                }
            }
            .listStyle(.plain)
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .refreshable { await load() }
            .task { await load() }
        }
    }

    @ViewBuilder
    private func row(_ event: PendingDelistService.DelistLogEvent) -> some View {
        let line = Self.line(for: event)
        VStack(alignment: .leading, spacing: 4) {
            Text(line.headline)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(line.open ? Color.brandRed : Color.primary)
            Text(line.detail)
                .font(.caption)
                .foregroundStyle(.secondary)
            if line.open, let urlString = event.url, let url = URL(string: urlString) {
                Link("Open the listing", destination: url)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.brandNavy)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    private func load() async {
        loading = events.isEmpty
        do {
            events = try await PendingDelistService.shared.delistLog(itemId: itemId)
            failed = false
        } catch {
            failed = true
        }
        loading = false
    }

    // MARK: - words, mirroring src/lib/delist-log-words.ts

    struct Line: Equatable {
        let headline: String
        let detail: String
        let open: Bool
    }

    private static let clock: DateFormatter = {
        let f = DateFormatter()
        f.timeStyle = .short
        f.dateStyle = .none
        return f
    }()

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoPlain = ISO8601DateFormatter()

    static func when(_ at: String) -> String {
        guard let date = iso.date(from: at) ?? isoPlain.date(from: at) else { return "" }
        return clock.string(from: date)
    }

    static func actorWord(_ actor: String) -> String {
        switch actor {
        case "server": return "GradeThread"
        case "browser": return "your browser"
        default: return "you"
        }
    }

    static func line(for e: PendingDelistService.DelistLogEvent) -> Line {
        // The registry names the cross-list channels; eBay is not one of them
        // and "Ebay" is not its name.
        let label = CrossListingRegistry.channel(id: e.platform)?.label
            ?? (e.platform == "ebay" ? "eBay" : ExtensionLifecycle.platformLabel(e.platform))
        let when = Self.when(e.at)
        let by = actorWord(e.actor)
        switch e.event {
        case "sold":
            return Line(headline: "Sold on \(label)", detail: when, open: false)
        case "ended_api":
            return Line(headline: "\(label) ended", detail: "\(when), \(by)", open: false)
        case "ended_extension":
            let detail = e.note.map { "\(when), \(by). \($0)" } ?? "\(when), \(by)"
            return Line(headline: "\(label) ended", detail: detail, open: false)
        case "ended_by_hand":
            return Line(headline: "\(label) ended", detail: "\(when), by you", open: false)
        case "queued":
            let detail = e.note.map { "Queued \(when). \($0)" }
                ?? "Queued \(when). Runs when a browser with the extension is open."
            return Line(headline: "\(label): ending from your browser", detail: detail, open: true)
        case "waiting":
            let detail = e.note ?? "Since \(when). End it yourself, or queue it for your browser."
            return Line(headline: "\(label): still live", detail: detail, open: true)
        default:
            let detail = e.note.map { "\(when). \($0) End it yourself." } ?? "\(when). End it yourself."
            return Line(headline: "\(label): could not be ended automatically", detail: detail, open: true)
        }
    }
}
