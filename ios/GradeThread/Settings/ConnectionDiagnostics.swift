import Foundation

/// One-shot connection probe used by the Settings diagnostics section.
/// Runs the *exact same* `SupabaseShared.client` the app uses, and reports
/// the raw outcome of a session read, a few table selects, and a storage
/// write — so an empty screen / failed upload can be traced to its cause:
///   • session error            → auth/token problem
///   • table returns `[]`        → RLS returns 0 rows for this user
///   • table returns `[{…}]`     → data flows; the sync merge is the bug
///   • table throws (401/perm…)  → the error is printed verbatim
///   • storage HTTP 4xx          → why photo upload fails
@MainActor
struct ConnectionDiagnostics {
    func run(localItemCount: Int) async -> String {
        var lines: [String] = []

        // How many rows actually made it into the on-device SwiftData store
        // (what the Home/Inventory/Money views @Query). If this is 0 while the
        // server returns rows, the merge — not the network — is the problem.
        lines.append("local SwiftData cache: \(localItemCount) items")

        // Config actually baked into this build.
        lines.append("supabase: \(AppConfig.supabaseURL.absoluteString)")
        lines.append("anon key: \(AppConfig.supabaseAnonKey.isEmpty ? "MISSING" : "present (\(AppConfig.supabaseAnonKey.count) chars)")")

        // Session
        var userId: String?
        lines.append("")
        lines.append("— session —")
        do {
            let session = try await SupabaseShared.client.auth.session
            userId = session.user.id.uuidString
            lines.append("user_id: \(session.user.id.uuidString)")
            // Security (audit 2026-06-24): email omitted — user_id is enough to
            // trace an RLS / empty-data issue, and this output is copyable. The
            // section is also internal-build-only (see DiagnosticsSection).
            lines.append("token: present (\(session.accessToken.prefix(6))…)")
            lines.append("expires_at: \(session.expiresAt)")
        } catch {
            lines.append("SESSION ERROR: \(error.localizedDescription)")
            lines.append(String(reflecting: error).prefix(400).description)
        }

        for table in ["inventory_items", "item_photos", "sales"] {
            lines.append("")
            lines.append("— \(table) —")
            await probeTable(table, into: &lines)
        }

        lines.append("")
        lines.append("— full pull (real columns + decode) —")
        await probeFullPull(into: &lines)

        lines.append("")
        lines.append("— storage write —")
        await probeStorage(userId: userId, into: &lines)

        return lines.joined(separator: "\n")
    }

    /// Runs the exact full-column select the sync engine uses + the resilient
    /// decoder, so the output confirms whether rows actually decode into items.
    private func probeFullPull(into lines: inout [String]) async {
        let columns = "id,user_id,title,brand,sku,size,color,material,status,target_price,acquired_price,grade_value,grade_label,certificate_url,condition_notes,measurements,created_at,updated_at"
        do {
            let response = try await SupabaseShared.client
                .from("inventory_items")
                .select(columns)
                .limit(50)
                .execute()
            let decoded = SyncEngine.decodeItemsResiliently(response.data)
            lines.append("select OK \(response.data.count)b → decoded \(decoded.count) items")
            if let first = decoded.first {
                lines.append("first: \(first.title) [\(first.status)]")
            }
        } catch {
            lines.append("FULL PULL ERROR: \(error.localizedDescription)")
            lines.append(String(reflecting: error).prefix(400).description)
        }
    }

    /// PostgREST read — supabase-swift attaches the session token automatically.
    private func probeTable(_ table: String, into lines: inout [String]) async {
        do {
            let response = try await SupabaseShared.client
                .from(table)
                .select("id")
                .limit(3)
                .execute()
            let raw = String(data: response.data, encoding: .utf8)
                ?? "<non-utf8 \(response.data.count) bytes>"
            lines.append("OK \(response.data.count)b: \(raw.prefix(300))")
        } catch {
            lines.append("ERROR: \(error.localizedDescription)")
            lines.append(String(reflecting: error).prefix(400).description)
        }
    }

    /// Replicates ``PhotoUploadService``'s manual Storage request so an upload
    /// failure surfaces as a concrete HTTP status + body. Uploads a tiny REAL
    /// JPEG with `image/jpeg` (not text/plain) so it actually exercises what a
    /// photo upload does — the buckets enforce an image-only MIME allowlist, so
    /// a text probe always 415s and never tests the true path. Cleans up after.
    private func probeStorage(userId: String?, into lines: inout [String]) async {
        guard let userId else { lines.append("skipped: no user id"); return }
        guard let token = await SupabaseShared.currentAccessToken() else {
            lines.append("no access token (currentAccessToken returned nil)")
            return
        }
        // Minimal valid 1x1 JPEG — the exact content-type a real upload sends.
        let jpeg = Data(base64Encoded:
            "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAC//EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AfwD/2Q=="
        ) ?? Data()
        let path = "/storage/v1/object/item-photos/\(userId.lowercased())/diagnostics/probe.jpg"
        var components = URLComponents(url: AppConfig.supabaseURL, resolvingAgainstBaseURL: false)!
        components.path = path
        guard let url = components.url else { lines.append("bad storage url"); return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
        request.setValue("true", forHTTPHeaderField: "x-upsert")
        request.httpBody = jpeg

        do {
            // Bounded session (US-992): a connectivity probe must fail fast
            // rather than hang ~60s on URLSession.shared's default timeout.
            let (data, response) = try await EdgeNetwork.shared.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? -1
            let body = String(data: data, encoding: .utf8)?.prefix(200) ?? ""
            lines.append("image upload HTTP \(code): \(body.isEmpty ? "(ok)" : String(body))")

            // Best-effort cleanup so the probe object doesn't linger.
            if (200..<300).contains(code) {
                var del = URLRequest(url: url)
                del.httpMethod = "DELETE"
                del.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                del.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
                _ = try? await EdgeNetwork.shared.data(for: del)
            }
        } catch {
            lines.append("ERROR: \(error.localizedDescription)")
        }
    }
}
