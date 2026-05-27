import Foundation
import UIKit

/// Cross-target inbox the Share Extension writes to + the main app
/// drains on next launch. Each entry is a directory under the App Group
/// container containing one or more JPEGs + a small `manifest.json`.
///
/// Both targets compile this file (project.yml lists it under both
/// sources). The App Group identifier MUST match the entitlement on
/// each target — change one and the other breaks silently.
public enum IntakeInbox {
    public static let appGroupIdentifier = "group.com.gradethread.app"
    private static let inboxDirectoryName = "intake-inbox"

    /// One staged intake batch from a single share. Files live under
    /// `appGroup/intake-inbox/<id>/photo-<n>.jpg` with a sibling
    /// `manifest.json` carrying per-photo slot assignments.
    public struct Batch: Identifiable, Equatable {
        public let id: String
        public let manifestURL: URL
        public let directory: URL
        public let manifest: Manifest
    }

    public struct Manifest: Codable, Equatable {
        public let id: String
        public let createdAt: Date
        public let photos: [PhotoEntry]
    }

    public struct PhotoEntry: Codable, Equatable {
        /// Filename relative to the batch directory. e.g. "photo-0.jpg".
        public let filename: String
        /// PhotoSlotType raw value (front / back / tag / detail / ...).
        public let slot: String
        public let bytes: Int
    }

    // MARK: - Reads

    /// Container URL for the App Group. Returns nil when the group
    /// isn't configured (e.g. running in an environment without the
    /// entitlement; tests).
    public static var containerURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupIdentifier)
    }

    public static var inboxDirectoryURL: URL? {
        containerURL?.appendingPathComponent(inboxDirectoryName, isDirectory: true)
    }

    public static func ensureInboxDirectory() throws {
        guard let url = inboxDirectoryURL else { return }
        if !FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.createDirectory(
                at: url, withIntermediateDirectories: true
            )
        }
    }

    /// Returns every staged batch sorted by createdAt ascending so the
    /// main app processes them in share order.
    public static func pendingBatches() -> [Batch] {
        guard let inbox = inboxDirectoryURL,
              let contents = try? FileManager.default.contentsOfDirectory(
                at: inbox,
                includingPropertiesForKeys: nil
              )
        else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        var batches: [Batch] = []
        for dir in contents where dir.hasDirectoryPath {
            let manifestURL = dir.appendingPathComponent("manifest.json")
            guard let data = try? Data(contentsOf: manifestURL),
                  let manifest = try? decoder.decode(Manifest.self, from: data)
            else { continue }
            batches.append(Batch(
                id: manifest.id,
                manifestURL: manifestURL,
                directory: dir,
                manifest: manifest
            ))
        }
        return batches.sorted { $0.manifest.createdAt < $1.manifest.createdAt }
    }

    /// Loads every photo from a batch into UIImages, paired with slot
    /// assignments. Caller hands the result to PhotoIntakeView via
    /// init(initialPhotos:).
    public static func materializePhotos(in batch: Batch) -> [(slot: String, image: UIImage, bytes: Data)] {
        var out: [(String, UIImage, Data)] = []
        for entry in batch.manifest.photos {
            let url = batch.directory.appendingPathComponent(entry.filename)
            guard let data = try? Data(contentsOf: url),
                  let image = UIImage(data: data) else { continue }
            out.append((entry.slot, image, data))
        }
        return out
    }

    // MARK: - Writes (extension side)

    /// Writes a new batch into the inbox directory + returns its id.
    /// The extension calls this from its 'Add to FlipDesk' action.
    @discardableResult
    public static func writeBatch(
        photos: [(slot: String, jpegData: Data)],
        now: Date = .now
    ) throws -> String {
        try ensureInboxDirectory()
        guard let inbox = inboxDirectoryURL else {
            throw NSError(
                domain: "IntakeInbox", code: -1,
                userInfo: [NSLocalizedDescriptionKey: "App Group container unavailable."]
            )
        }
        let id = UUID().uuidString
        let dir = inbox.appendingPathComponent(id, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        var entries: [PhotoEntry] = []
        for (idx, photo) in photos.enumerated() {
            let filename = "photo-\(idx).jpg"
            let url = dir.appendingPathComponent(filename)
            try photo.jpegData.write(to: url, options: [.atomic])
            entries.append(PhotoEntry(
                filename: filename,
                slot: photo.slot,
                bytes: photo.jpegData.count
            ))
        }
        let manifest = Manifest(id: id, createdAt: now, photos: entries)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted]
        let manifestData = try encoder.encode(manifest)
        try manifestData.write(to: dir.appendingPathComponent("manifest.json"), options: [.atomic])
        return id
    }

    // MARK: - Cleanup (main-app side)

    /// Removes a processed batch. The main app calls this after
    /// successfully presenting the photos through PhotoIntakeView so
    /// the same share doesn't replay on the next launch.
    public static func consume(_ batch: Batch) {
        try? FileManager.default.removeItem(at: batch.directory)
    }
}
