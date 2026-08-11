import XCTest
import UIKit
@testable import GradeThread

/// US-189 — exercises the IntakeInbox round-trip + the ShareInboxConsumer
/// mapping back into PhotoSlotType / PhotoCapture territory.
///
/// The App Group container itself only exists in a signed sandboxed app,
/// so these tests redirect IntakeInbox to a temp directory via a
/// per-test FileManager override pattern: we don't reach for the real
/// `containerURL` in any code path the consumer touches. The writer +
/// reader are both pure-Foundation, so a tmp URL exercises the same
/// disk layout XCTest cares about.
@MainActor
final class ShareInboxTests: XCTestCase {

    private var sandbox: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        sandbox = FileManager.default.temporaryDirectory
            .appendingPathComponent("ShareInboxTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(
            at: sandbox, withIntermediateDirectories: true
        )
    }

    override func tearDownWithError() throws {
        if let sandbox { try? FileManager.default.removeItem(at: sandbox) }
        try super.tearDownWithError()
    }

    // MARK: - Round-trip

    func test_writeAndRead_preservesSlotsAndOrder() throws {
        let inbox = sandbox.appendingPathComponent("intake-inbox", isDirectory: true)
        try writeRawBatch(
            into: inbox,
            id: "batch-1",
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            photos: [
                ("front", makeJPEG(color: .red)),
                ("back",  makeJPEG(color: .green)),
                ("tag",   makeJPEG(color: .blue)),
            ]
        )

        let batches = readBatches(from: inbox)
        XCTAssertEqual(batches.count, 1)
        XCTAssertEqual(batches.first?.manifest.photos.count, 3)
        XCTAssertEqual(batches.first?.manifest.photos.map(\.slot), ["front", "back", "tag"])
    }

    func test_read_ordersByCreatedAtAscending() throws {
        let inbox = sandbox.appendingPathComponent("intake-inbox", isDirectory: true)
        try writeRawBatch(
            into: inbox,
            id: "newer",
            createdAt: Date(timeIntervalSince1970: 1_700_001_000),
            photos: [("front", makeJPEG(color: .red))]
        )
        try writeRawBatch(
            into: inbox,
            id: "older",
            createdAt: Date(timeIntervalSince1970: 1_700_000_000),
            photos: [("front", makeJPEG(color: .green))]
        )
        let batches = readBatches(from: inbox)
        XCTAssertEqual(batches.map(\.id), ["older", "newer"])
    }

    func test_materializePhotos_decodesJPEGsBackToUIImage() throws {
        let inbox = sandbox.appendingPathComponent("intake-inbox", isDirectory: true)
        try writeRawBatch(
            into: inbox,
            id: "batch-decode",
            createdAt: Date(),
            photos: [
                ("front",   makeJPEG(color: .red)),
                ("defect1", makeJPEG(color: .blue)),
            ]
        )
        guard let batch = readBatches(from: inbox).first else {
            return XCTFail("expected one batch")
        }
        let materialized = IntakeInbox.materializePhotos(in: batch)
        XCTAssertEqual(materialized.count, 2)
        XCTAssertEqual(materialized.map(\.slot), ["front", "defect1"])
        XCTAssertTrue(materialized.allSatisfy { $0.image.size.width > 0 })
    }

    // MARK: - Manifest parsing

    func test_read_skipsBatchWithMissingManifest() throws {
        let inbox = sandbox.appendingPathComponent("intake-inbox", isDirectory: true)
        // Valid batch + a sibling directory without manifest.json.
        try writeRawBatch(
            into: inbox,
            id: "good",
            createdAt: Date(),
            photos: [("front", makeJPEG(color: .red))]
        )
        let bogusDir = inbox.appendingPathComponent("bogus", isDirectory: true)
        try FileManager.default.createDirectory(at: bogusDir, withIntermediateDirectories: true)
        try Data().write(to: bogusDir.appendingPathComponent("not-a-manifest.txt"))

        let batches = readBatches(from: inbox)
        XCTAssertEqual(batches.map(\.id), ["good"])
    }

    // MARK: - ShareInboxConsumer slot mapping

    func test_consumer_mapsRawSlotsToCaptureSlot() throws {
        // Synthesise a DrainedBatch directly — we're testing the slot
        // key mapping is in lock-step with CaptureSlot, not the disk
        // round-trip (covered above).
        let entries: [(slot: String, image: UIImage, bytes: Data)] = [
            ("front",   makeUIImage(color: .red),   makeJPEG(color: .red)),
            ("defect3", makeUIImage(color: .gray),  makeJPEG(color: .gray)),
            ("not-a-slot", makeUIImage(color: .black), makeJPEG(color: .black)),
        ]
        var mapped: [CaptureSlot: PhotoCapture] = [:]
        for entry in entries {
            guard let slot = CaptureSlot(storageKey: entry.slot),
                  let thumbnail = entry.image.preparingThumbnail(of: CGSize(width: 240, height: 240))
            else { continue }
            mapped[slot] = PhotoCapture(
                imageData: entry.bytes,
                thumbnail: thumbnail,
                source: .library
            )
        }
        XCTAssertEqual(Set(mapped.keys), [CaptureSlot(.front), CaptureSlot(.defect3)])
        XCTAssertNil(mapped[.back])
    }

    func test_materializeSlotPhotos_decodesBatchOffMainAndMapsSlots() throws {
        // US-1273: the decode/thumbnail path now lives in the reusable,
        // nonisolated `materializeSlotPhotos` (run off-main by popNext). Drive
        // it directly from a disk batch — a known slot maps, an unknown one is
        // dropped, and the thumbnail is materialised.
        let inbox = sandbox.appendingPathComponent("intake-inbox", isDirectory: true)
        try writeRawBatch(
            into: inbox,
            id: "materialize",
            createdAt: Date(),
            photos: [
                ("front",      makeJPEG(color: .red)),
                ("not-a-slot", makeJPEG(color: .black)),
            ]
        )
        guard let batch = readBatches(from: inbox).first else {
            return XCTFail("expected one batch")
        }
        let mapped = ShareInboxConsumer.materializeSlotPhotos(in: batch)
        XCTAssertEqual(Set(mapped.keys), [.front])
        XCTAssertNotNil(mapped[.front]?.thumbnail)
        XCTAssertEqual(mapped[.front]?.source, .library)
    }

    func test_materializeSlotPhotos_emptyWhenNoSlotsDecode() throws {
        // Every entry has an unknown slot → empty map (the caller treats this
        // as the "couldn't read the shared photos" case and alerts, US-1273).
        let inbox = sandbox.appendingPathComponent("intake-inbox", isDirectory: true)
        try writeRawBatch(
            into: inbox,
            id: "all-unknown",
            createdAt: Date(),
            photos: [("mystery-slot", makeJPEG(color: .red))]
        )
        guard let batch = readBatches(from: inbox).first else {
            return XCTFail("expected one batch")
        }
        XCTAssertTrue(ShareInboxConsumer.materializeSlotPhotos(in: batch).isEmpty)
    }

    // MARK: - ShareIntakeView slot constants

    func test_shareExtensionSlotConstants_alignWithPhotoSlotType() {
        // The Share Extension can't import PhotoSlotType directly
        // (separate target without a shared framework), so it mirrors
        // the raw values manually. If PhotoSlotType ever adds a case
        // or renames a raw value, this test trips.
        let mirroredSlots: [String] = [
            "front", "back", "tag", "detail",
            "measurement_chest", "measurement_waist", "measurement_length",
            "measurement_sleeve", "measurement_inseam",
            "defect1", "defect2", "defect3",
            "tag_2", "detail_2", "detail_3", "detail_4",
            "interior", "flatlay", "on_model",
            // US-1571: the MeasureCard calibration-frame tag.
            "measurement",
            "angle", "sole", "marking", "serial", "accessory",
            "certificate", "corner", "surface",
            // US-2470: the two profile roles that gained a capture case.
            "on_hanger", "set_pair",
        ]
        let canonical = PhotoSlotType.allCases.map(\.rawValue)
        XCTAssertEqual(mirroredSlots, canonical,
            "Share Extension slot list drifted from PhotoSlotType — update ShareIntakeView.allSlots."
        )
    }

    // MARK: - Helpers

    /// Inlined version of `IntakeInbox.writeBatch` that writes to an
    /// arbitrary directory (the public API only writes into the App
    /// Group container, which doesn't exist in unit tests).
    private func writeRawBatch(
        into inboxDir: URL,
        id: String,
        createdAt: Date,
        photos: [(slot: String, data: Data)]
    ) throws {
        try FileManager.default.createDirectory(at: inboxDir, withIntermediateDirectories: true)
        let batchDir = inboxDir.appendingPathComponent(id, isDirectory: true)
        try FileManager.default.createDirectory(at: batchDir, withIntermediateDirectories: true)
        var entries: [IntakeInbox.PhotoEntry] = []
        for (idx, photo) in photos.enumerated() {
            let filename = "photo-\(idx).jpg"
            try photo.data.write(to: batchDir.appendingPathComponent(filename))
            entries.append(IntakeInbox.PhotoEntry(
                filename: filename,
                slot: photo.slot,
                bytes: photo.data.count
            ))
        }
        let manifest = IntakeInbox.Manifest(id: id, createdAt: createdAt, photos: entries)
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        let data = try enc.encode(manifest)
        try data.write(to: batchDir.appendingPathComponent("manifest.json"))
    }

    /// Mirrors IntakeInbox.pendingBatches() against an arbitrary inbox URL.
    private func readBatches(from inboxDir: URL) -> [IntakeInbox.Batch] {
        guard let contents = try? FileManager.default.contentsOfDirectory(
            at: inboxDir, includingPropertiesForKeys: nil
        ) else { return [] }
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        var out: [IntakeInbox.Batch] = []
        for dir in contents where dir.hasDirectoryPath {
            let manifestURL = dir.appendingPathComponent("manifest.json")
            guard let data = try? Data(contentsOf: manifestURL),
                  let manifest = try? dec.decode(IntakeInbox.Manifest.self, from: data)
            else { continue }
            out.append(IntakeInbox.Batch(
                id: manifest.id,
                manifestURL: manifestURL,
                directory: dir,
                manifest: manifest
            ))
        }
        return out.sorted { $0.manifest.createdAt < $1.manifest.createdAt }
    }

    private func makeUIImage(color: UIColor, size: CGSize = CGSize(width: 100, height: 100)) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            color.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
        }
    }

    private func makeJPEG(color: UIColor, size: CGSize = CGSize(width: 100, height: 100)) -> Data {
        guard let data = makeUIImage(color: color, size: size).jpegData(compressionQuality: 0.85) else {
            return Data()
        }
        return data
    }
}
