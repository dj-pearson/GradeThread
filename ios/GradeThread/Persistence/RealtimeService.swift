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

    public init(supabase: SupabaseClient = SupabaseShared.client, syncEngine: SyncEngine) {
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
            try await channel.subscribe()
        } catch {
            print("[Realtime] subscribe failed: \(error)")
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
        case .select:
            // Not a mutation — Supabase emits these for replay state
            // sync; we ignore them.
            break
        }
    }

    private func applyUpsert(record: [String: AnyJSON]) async {
        // Convert the AnyJSON dict back to raw JSON data so the
        // SyncEngine's existing decoder can route it through
        // RemoteInventoryItem without us re-implementing decode here.
        guard let data = try? JSONEncoder().encode(record) else { return }
        await syncEngine.applyRealtimeInventoryUpsert(record: data)
    }

    /// Helper that pulls a string field out of the AnyJSON record. Used
    /// for the delete path where we only need the row id.
    private func stringValue(from record: [String: AnyJSON], key: String) -> String? {
        guard let value = record[key] else { return nil }
        if case let .string(s) = value { return s }
        return nil
    }

    private func applyStatus(_ status: RealtimeSubscribeStates) {
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
