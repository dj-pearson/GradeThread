import Foundation

/// US-2964 - the description preview's request scheduler, ported from
/// `src/lib/description-preview.ts`.
///
/// The preview shows the exact string eBay will receive, which only the edge
/// renderer can produce, so every keystroke in a block editor is a potential
/// round trip. Two things have to hold and neither is free:
///
///   1. DEBOUNCE. 400ms, the same figure the web uses. Typing an intro must not
///      fire a request per character.
///   2. LAST REQUEST WINS. Two in-flight renders can come back in either order,
///      and a slow EARLIER one landing after a fast LATER one would put stale
///      bytes under a seller who is about to publish them. The sequence number
///      here is what makes that impossible - a response whose sequence is not
///      the newest issued is dropped, not delivered.
///
/// An actor, so the counter cannot race, and pure enough to be tested on Linux
/// with a fake fetcher rather than inferred from a mounted screen.
public enum DescriptionPreview {
    /// The debounce window, shared with the web so the two behave alike.
    public static let debounceMilliseconds: UInt64 = 400
}

public actor DescriptionPreviewScheduler<Payload: Sendable, Result: Sendable> {

    private let delayMilliseconds: UInt64
    private let fetcher: @Sendable (Payload) async throws -> Result
    private let onResult: @Sendable (Result) async -> Void
    private let onPending: @Sendable (Bool) async -> Void
    private let onError: @Sendable (Error) async -> Void

    /// The debounce timer, and ONLY the timer. See ``start(_:)``.
    private var timer: Task<Void, Never>?
    /// Monotonic. The newest request's number; a settled response is only
    /// allowed to speak if it still carries it.
    private var issued: UInt64 = 0

    public init(
        delayMilliseconds: UInt64 = DescriptionPreview.debounceMilliseconds,
        fetcher: @escaping @Sendable (Payload) async throws -> Result,
        onResult: @escaping @Sendable (Result) async -> Void,
        onPending: @escaping @Sendable (Bool) async -> Void = { _ in },
        onError: @escaping @Sendable (Error) async -> Void = { _ in }
    ) {
        self.delayMilliseconds = delayMilliseconds
        self.fetcher = fetcher
        self.onResult = onResult
        self.onPending = onPending
        self.onError = onError
    }

    /// Queue a render. Resets the debounce window.
    public func request(_ payload: Payload) {
        timer?.cancel()
        let nanoseconds = delayMilliseconds * 1_000_000
        timer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: nanoseconds)
            if Task.isCancelled { return }
            await self?.start(payload)
        }
    }

    /// Drop the pending timer and orphan every response still in flight.
    public func cancel() {
        timer?.cancel()
        timer = nil
        // Bumping the counter orphans everything in flight: no settled call can
        // match it any more, so a screen going away cannot write into dead
        // state. Note it does NOT cancel the request - see ``start(_:)``.
        issued &+= 1
        let notify = onPending
        Task { await notify(false) }
    }

    /// Launch one render.
    ///
    /// The fetch runs in an unstructured task the debounce timer does not own,
    /// which is deliberate: a newer request must not CANCEL the call an older
    /// one already started. Cancelling would look like it was doing the same job
    /// as the sequence number and would quietly replace it, so the guard that
    /// actually protects the seller would stop being exercised - and an
    /// already-answered request would be thrown away for nothing.
    private func start(_ payload: Payload) {
        issued &+= 1
        let seq = issued
        let fetcher = self.fetcher
        let onResult = self.onResult
        let onPending = self.onPending
        let onError = self.onError
        Task { [weak self] in
            await onPending(true)
            do {
                let result = try await fetcher(payload)
                guard await self?.isCurrent(seq) == true else { return }
                await onPending(false)
                await onResult(result)
            } catch {
                guard await self?.isCurrent(seq) == true else { return }
                await onPending(false)
                await onError(error)
            }
        }
    }

    private func isCurrent(_ seq: UInt64) -> Bool { seq == issued }
}
