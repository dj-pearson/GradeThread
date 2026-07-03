import Foundation

/// The `item_photos` row the upload service inserts after a successful
/// storage upload. Extracted from ``PhotoUploadService`` so its JSON shape is
/// unit-testable (see ReconcileIntakeTests).
///
/// `captured_at` (the original EXIF/PHAsset capture time, migration 00066) and
/// `reconcile_session_id` (migration 00066, set when a photo was ingested
/// through a Photo Dump Reconciliation session) are optional and OMITTED from
/// the JSON when nil — so existing single-item uploads send exactly the same
/// payload they did before, plus `captured_at` when the device knows it.
struct ItemPhotoInsert: Encodable, Equatable {
    /// Client-supplied primary key. We set it (rather than letting Postgres
    /// default `gen_random_uuid()`) so the direct insert and any retry/replay
    /// target the SAME row — a lost insert response no longer leaves a second
    /// row behind with a fresh id (the iOS duplicate-photo bug).
    let id: String
    let inventory_item_id: String
    let photo_type: String
    let storage_path: String
    let photo_url: String
    let sort_order: Int
    let bytes: Int64
    var captured_at: Date?
    /// US-1547: the source file's original name (00339 provenance), omitted
    /// when the device doesn't know it (camera captures).
    var original_filename: String?
    var reconcile_session_id: String?

    enum CodingKeys: String, CodingKey {
        case id
        case inventory_item_id
        case photo_type
        case storage_path
        case photo_url
        case sort_order
        case bytes
        case captured_at
        case original_filename
        case reconcile_session_id
    }

    /// ISO-8601 (internet date-time) matches the web client's
    /// `Date.toISOString()` and Postgres `timestamptz` parsing.
    static let captureFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(inventory_item_id, forKey: .inventory_item_id)
        try c.encode(photo_type, forKey: .photo_type)
        try c.encode(storage_path, forKey: .storage_path)
        try c.encode(photo_url, forKey: .photo_url)
        try c.encode(sort_order, forKey: .sort_order)
        try c.encode(bytes, forKey: .bytes)
        // Omit the optionals entirely when nil (encodeIfPresent skips them),
        // so non-reconcile uploads don't start writing explicit nulls.
        if let captured_at {
            try c.encode(Self.captureFormatter.string(from: captured_at), forKey: .captured_at)
        }
        try c.encodeIfPresent(original_filename, forKey: .original_filename)
        try c.encodeIfPresent(reconcile_session_id, forKey: .reconcile_session_id)
    }
}
