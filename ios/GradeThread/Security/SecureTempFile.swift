import Foundation

/// US-694 — sensitive exports (financial CSV/PDF, account-data JSON) must not
/// linger unprotected in the temp directory. Every other at-rest write in the
/// app uses `.completeFileProtectionUntilFirstUserAuthentication` (US-658); the
/// two export paths historically wrote `.atomic` only and never cleaned up.
///
/// This helper centralizes the secure pattern: writes go to a dedicated swept
/// `Exports/` subdirectory created with the protected class, callers delete the
/// file once the share sheet hands it off, and `sweep()` (run at launch) clears
/// anything an interrupted share left behind. Pure/value-typed so it's testable.
enum SecureTempFile {

    /// The protection class the rest of the app uses for at-rest sensitive data.
    static let writingOptions: Data.WritingOptions = [
        .atomic,
        .completeFileProtectionUntilFirstUserAuthentication,
    ]

    /// Dedicated subdirectory for sensitive exports so a single `sweep()` can
    /// clear them without touching unrelated temp files. Created lazily with the
    /// protected file-protection attribute.
    static var directory: URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("Exports", isDirectory: true)
        try? FileManager.default.createDirectory(
            at: dir,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        return dir
    }

    /// Writes `data` to `Exports/<filename>` with file protection applied.
    @discardableResult
    static func write(_ data: Data, filename: String) throws -> URL {
        let url = directory.appendingPathComponent(filename)
        try data.write(to: url, options: writingOptions)
        return url
    }

    /// Removes a single exported file (call after the share sheet dismisses).
    static func delete(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }

    /// Removes every file left in `Exports/`. Safe to call at launch.
    static func sweep() {
        let fm = FileManager.default
        guard let urls = try? fm.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil
        ) else { return }
        for url in urls { try? fm.removeItem(at: url) }
    }
}
