import Foundation
import Observation
import Supabase

/// Subscribes to Postgres-change events for the signed-in user's
/// inventory_items rows and feeds them into ``SyncEngine`` so
/// SwiftData reflects server-side edits the moment they hit the wire.
///
/// Lifecycle:
///   - `start(userId:)` opens the channel filtered to that user.
///   - `pause()` unsubscribes (called when the app backgrounds — battery).
///   - `start` again on next foreground re-subscribes; supabase-swift
///     handles socket reconnects + heartbeat.
///
/// We only subscribe to inventory_items for now. Sales + listings can
/// follow the same pattern; a single channel per table keeps the
/// status-change observers tractable.
@MainActor
@Observable
public final class RealtimeService {
    public enum Phase: Equatable {
        case idle
        case subscribing
        case subscribed
        case reconnecting
        case disabled
    }

    public var phase: Phase = .idle

    private let supabase: SupabaseClient
    private let syncEngine: SyncEngine
    private var channel: RealtimeChannelV2?
    private var listenTask: Task<Void, Never>?
    private var statusTask: Task<Void, Never>?

    private static let userDefaultsKey = "com.gradethread.app.realtime.enabled"

    init(supabase: SupabaseClient = SupabaseShared.client, syncEngine: SyncEngine) {
        self.supabase = supabase
        self.syncEngine = syncEngine
    }

    /// User-facing 'Live updates' toggle. Default ON; flipping off
    /// stops + cleans up the channel so battery + data costs go to
    /// zero for users who'd rather pull-to-refresh.
    public var isEnabled: Bool {
        get {
            UserDefaults.standard.object(forKey: Self.userDefaultsKey)
                .flatMap { ($0 as? Bool) } ?? true
        }
        set {
            UserDefaults.standard.set(newValue, forKey: Self.userDefaultsKey)
            if !newValue {
                Task { await stop() }
            }
        }
    }

    // MARK: - Lifecycle

    public func start(userId: String) async {
        guard isEnabled else {
            phase = .disabled
            return
        }
        guard channel == nil else { return }

        phase = .subscribing

        // One channel scoped to the user's inventory rows. The filter
        // is enforced on the server (PostgREST + Realtime's row
        // filter), so we don't get other users' events even if the
        // RLS policy is somehow misconfigured.
        let channel = supabase.channel("inventory:\(userId)")
        self.channel = channel

        // Subscribe to all actions so we hit one stream — easier than
        // three separate Insert/Update/Delete streams. We branch on the
        // action kind inside the handler.
        let stream = channel.postgresChange(
            AnyAction.self,
            schema: "public",
            table: "inventory_items",
            filter: .eq("user_id", value: userId)
        )

        statusTask = Task { [weak self, channel] in
            for await status in channel.statusChange {
                await MainActor.run { [weak self] in
                    self?.applyStatus(status)
                }
            }
        }

        listenTask = Task { [weak self, stream] in
            for await action in stream {
                guard let self else { return }
                await self.dispatch(action: action)
            }
        }

        do {
            try await channel.subscribeWithError()
        } catch {
            // US-662 / US-698: keep error detail out of release logs, and even
            // in DEBUG log the redacted localizedDescription rather than the
            // full error (which can embed the channel topic / access token).
            #if DEBUG
            print("[Realtime] subscribe failed: \(TelemetryScrubber.redact(error.localizedDescription))")
            #endif
            phase = .reconnecting
        }
    }

    public func pause() async {
        await stop()
    }

    public func stop() async {
        listenTask?.cancel()
        listenTask = nil
        statusTask?.cancel()
        statusTask = nil
        if let channel {
            await supabase.removeChannel(channel)
        }
        channel = nil
        phase = .idle
    }

    // MARK: - Dispatch

    private func dispatch(action: AnyAction) async {
        // Each action type carries either `record` (insert/update) or
        // an `oldRecord`-only delete. We hand the raw JSON to the
        // SyncEngine which decodes through the same shape the polled
        // fetch uses.
        switch action {
        case .insert(let insert):
            await applyUpsert(record: insert.record)
        case .update(let update):
            await applyUpsert(record: update.record)
        case .delete(let delete):
            // Delete payload only carries the primary key.
            if let id = stringValue(from: delete.oldRecord, key: "id") {
                await syncEngine.applyRealtimeInventoryDelete(id: id)
            }
        @unknown default:
            // Newer SDKs may emit additional action kinds (e.g. select
            // replay-state events). We only act on inventory mutations.
            break
        }
    }

    private func applyUpsert(record: [String: AnyJSON]) async {
        // Convert the AnyJSON dict back to raw JSON data so the
        // SyncEngine's existing decoder can route it through
        // RemoteInventoryItem without us re-implementing decode here.
        //
        // US-968: JSONEncoder().encode used to run synchronously on the
        // main actor for every upserted row — a large payload (long
        // condition notes, measurements blob) could stall typing/scrolling
        // while the sync channel was busy. Encode on a detached task so the
        // main thread only does the final actor hop into the SyncEngine
        // (itself a background `actor`, so the decode is already off-main).
        //
        // Ordering is preserved: the realtime listen loop awaits each
        // `dispatch` fully (this method included), so the detached encode
        // and the subsequent SyncEngine apply complete in order — no
        // fire-and-forget that could reorder or drop a burst of updates.
        // Trailing-closure form isn't allowed in a guard condition (the `{` is
        // parsed as the guard body) — use the explicit `operation:` label.
        guard let data = await Task.detached(priority: .utility, operation: {
            Self.encodeRealtimeRecord(record)
        }).value else { return }
        await syncEngine.applyRealtimeInventoryUpsert(record: data)
    }

    /// Serializes a realtime record to JSON. `nonisolated static` so the
    /// `Task.detached` in ``applyUpsert(record:)`` runs it off the main
    /// actor; exposed at `internal` visibility for the off-main-thread
    /// coverage in `RealtimeTests`.
    nonisolated static func encodeRealtimeRecord(_ record: [String: AnyJSON]) -> Data? {
        try? JSONEncoder().encode(record)
    }

    /// Helper that pulls a string field out of the AnyJSON record. Used
    /// for the delete path where we only need the row id.
    private func stringValue(from record: [String: AnyJSON], key: String) -> String? {
        guard let value = record[key] else { return nil }
        if case let .string(s) = value { return s }
        return nil
    }

    private func applyStatus(_ status: RealtimeChannelStatus) {
        // Map supabase-swift's status to our UI-level phase. The actual
        // case names vary slightly across SDK versions; we accept the
        // common four states + leave the default branch open.
        switch status {
        case .subscribed:
            phase = .subscribed
        case .unsubscribed, .unsubscribing:
            phase = .idle
        case .subscribing:
            phase = .subscribing
        @unknown default:
            phase = .reconnecting
        }
    }
}
