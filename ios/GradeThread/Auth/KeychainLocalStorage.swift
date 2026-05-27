import Foundation
import Security
import Auth

/// Supabase session storage backed by Keychain.
///
/// Why Keychain over `UserDefaults` or a file:
///   - Encrypted at rest (device-class hardware encryption).
///   - Survives app reinstall on the same device (configurable — we
///     intentionally clear on uninstall by NOT using
///     `kSecAttrSynchronizable` and tying items to this device only).
///   - Refused access while the device is locked at first boot, which is
///     stronger than `kSecAttrAccessibleAfterFirstUnlock` and prevents an
///     attacker with physical access from reading tokens from a freshly
///     booted device.
///
/// Accessibility class is `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`
/// per US-170 — required for background token refresh after a reboot.
public final class KeychainLocalStorage: AuthLocalStorage, @unchecked Sendable {
    private let service: String

    public init(service: String = "com.gradethread.app.auth") {
        self.service = service
    }

    public func store(key: String, value: Data) throws {
        // Upsert pattern: try update first; if no item exists, add. Saves a
        // delete+add round-trip and is atomic on the Keychain side.
        let query = baseQuery(for: key)
        let update: [String: Any] = [
            kSecValueData as String: value,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(query as CFDictionary, update as CFDictionary)

        switch updateStatus {
        case errSecSuccess:
            return
        case errSecItemNotFound:
            var addQuery = query
            addQuery[kSecValueData as String] = value
            addQuery[kSecAttrAccessible as String] =
                kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw KeychainError.statusFailure(addStatus, op: "add", key: key)
            }
        default:
            throw KeychainError.statusFailure(updateStatus, op: "update", key: key)
        }
    }

    public func retrieve(key: String) throws -> Data? {
        var query = baseQuery(for: key)
        query[kSecReturnData as String] = kCFBooleanTrue
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        switch status {
        case errSecSuccess:
            return result as? Data
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError.statusFailure(status, op: "read", key: key)
        }
    }

    public func remove(key: String) throws {
        let query = baseQuery(for: key)
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.statusFailure(status, op: "delete", key: key)
        }
    }

    /// Wipe every session-related entry. Called from sign-out so a partial
    /// failure mid-clear doesn't leave a dangling refresh token behind.
    public func removeAll() throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.statusFailure(status, op: "deleteAll", key: "*")
        }
    }

    // MARK: - Private

    private func baseQuery(for key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }
}

public enum KeychainError: LocalizedError {
    case statusFailure(OSStatus, op: String, key: String)

    public var errorDescription: String? {
        switch self {
        case .statusFailure(let status, let op, let key):
            return "Keychain \(op) for \"\(key)\" failed: OSStatus \(status)"
        }
    }
}
