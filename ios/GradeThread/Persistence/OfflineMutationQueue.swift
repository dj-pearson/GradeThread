import Foundation
import SwiftData

/// Centralizes the offline write queue (US-640 / US-982). Any user write that
/// fails for a *true network reason* is queued here as a
/// ``LocalPendingMutation``; the ``SyncEngine`` drains the queue on reconnect,
/// replaying each mutation idempotently — a client-generated `id` injected into
/// every create payload turns the replay into an UPSERT, so a retry after a
/// partial success can't duplicate the row.
///
/// CRITICAL (US-982 AC5): only genuine connectivity failures are queued.
/// Application-level rejections (4xx / RLS denial / enum or validation errors)
/// must surface to the user, NOT silently queue — otherwise a permanently
/// rejected write would replay forever. ``shouldQueue(_:)`` draws that line via
/// the locale-independent ``FriendlyErrorCopy/isOffline(_:)`` classifier.
enum OfflineMutationQueue {

    /// True when `error` is a real connectivity failure and the write should be
    /// queued for replay; false for an app-level rejection that must surface.
    nonisolated static func shouldQueue(_ error: Error) -> Bool {
        FriendlyErrorCopy.isOffline(error)
    }

    /// Queue a CREATE. Injects a client-generated `id` into the JSON payload (so
    /// the replay UPSERTs idempotently) and mirrors it into `targetId` so the
    /// pending-changes inspector (US-641) can name the row. Returns the id used,
    /// or nil if the payload couldn't be encoded.
    ///
    /// Operates synchronously on the caller-supplied `context`, so it inherits
    /// the caller's isolation — no `@MainActor` hop, callable from a view, a
    /// `@MainActor` store, or a test alike.
    @discardableResult
    static func enqueueCreate(
        kind: MutationKind,
        payload: some Encodable,
        // US-1494: lowercased to match Postgres `uuid` normalization — an
        // UPPERCASE client id misses the case-sensitive sync-merge lookup on
        // pull-back and duplicates the row.
        id: String = UUID().uuidString.lowercased(),
        in context: ModelContext
    ) -> String? {
        guard let base = try? JSONEncoder().encode(payload),
              var dict = (try? JSONSerialization.jsonObject(with: base)) as? [String: Any]
        else { return nil }
        // US-1494: NEVER overwrite an id the payload already minted. Callers like
        // ExpenseStore encode a lowercase client id into the payload AND mirror it
        // locally under that id; overwriting it here with a fresh (uppercase)
        // default made the replayed server row's id differ from the local mirror →
        // a DUPLICATE row until delete-reconciliation. Use the payload's id when
        // present; otherwise the (lowercased) parameter.
        let existingId = (dict["id"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let resolvedId = existingId ?? id
        dict["id"] = resolvedId
        guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return nil }
        insert(LocalPendingMutation(kind: kind, payload: data, targetId: resolvedId), in: context)
        return resolvedId
    }

    /// Queue an UPDATE against an existing server row `targetId`. Returns false
    /// if the patch couldn't be encoded.
    @discardableResult
    static func enqueueUpdate(
        kind: MutationKind,
        payload: some Encodable,
        targetId: String,
        in context: ModelContext
    ) -> Bool {
        guard let data = try? JSONEncoder().encode(payload) else { return false }
        insert(LocalPendingMutation(kind: kind, payload: data, targetId: targetId), in: context)
        return true
    }

    /// Queue a DELETE of an existing server row `targetId`. The payload is empty
    /// — the replay handler only needs the id.
    static func enqueueDelete(
        kind: MutationKind,
        targetId: String,
        in context: ModelContext
    ) {
        insert(LocalPendingMutation(kind: kind, payload: Data(), targetId: targetId), in: context)
    }

    private static func insert(_ mutation: LocalPendingMutation, in context: ModelContext) {
        context.insert(mutation)
        context.saveOrLog("insert")
    }
}
