import Foundation
import Observation

/// Drives the native Scheduled Drops surface (US-1127): loads scheduled drafts,
/// reschedules and cancels them, and exposes the viewer's display timezone.
/// Mirrors the phase + action-feedback shape of the other FlipDesk stores
/// (`actionError` → alert, `actionBanner` → transient capsule).
@MainActor
@Observable
final class ScheduledDropsStore {
    enum Phase: Equatable {
        case loading
        case ready
        case failed(message: String)
    }

    private let service: ScheduledDropsProviding

    var phase: Phase = .loading
    private(set) var drops: [ScheduledDrop] = []
    var actionError: String?
    var actionBanner: String?
    /// The IANA zone the times + presets are evaluated/displayed in.
    var timeZoneIdentifier: String

    init(
        service: ScheduledDropsProviding = ScheduledDropsService(),
        timeZoneIdentifier: String = ScheduledDropScheduling.detectTimezone()
    ) {
        self.service = service
        self.timeZoneIdentifier = timeZoneIdentifier
    }

    var isEmpty: Bool { drops.isEmpty }

    func load() async {
        phase = .loading
        do {
            drops = try await service.list()
            phase = .ready
        } catch {
            phase = .failed(message: error.localizedDescription)
        }
    }

    /// Reschedule a drop to an explicit instant. Optimistically updates + re-sorts
    /// the local list on success; surfaces an error alert on failure.
    func reschedule(_ drop: ScheduledDrop, to date: Date) async {
        do {
            try await service.reschedule(listingId: drop.id, to: date)
            if let index = drops.firstIndex(where: { $0.id == drop.id }) {
                drops[index] = drop.withScheduledDate(date)
                drops.sort { $0.scheduledPublishAt < $1.scheduledPublishAt }
            }
            actionBanner = "Drop rescheduled."
            HapticFeedback.success()
        } catch {
            actionError = error.localizedDescription
            HapticFeedback.error()
        }
    }

    /// Reschedule via a peak-time preset, evaluated in the current timezone.
    func reschedule(_ drop: ScheduledDrop, preset: DropPreset) async {
        let date = ScheduledDropScheduling.nextPresetDate(preset, timeZoneIdentifier: timeZoneIdentifier)
        await reschedule(drop, to: date)
    }

    /// Cancel a scheduled drop (the draft itself is kept). Optimistically removes
    /// it; restores on failure.
    func cancel(_ drop: ScheduledDrop) async {
        let snapshot = drops
        drops.removeAll { $0.id == drop.id }
        do {
            try await service.cancel(listingId: drop.id)
            actionBanner = "Scheduled drop cancelled."
            HapticFeedback.success()
        } catch {
            drops = snapshot
            actionError = error.localizedDescription
            HapticFeedback.error()
        }
    }
}
