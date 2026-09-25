/**
 * US-3514: true when a storage path sits inside the owner's own folder.
 * Tenant paths are `{ownerFolder}/...`; anything else (another tenant's
 * folder, a traversal segment, a leading slash) is refused. Check it before
 * reading a client-supplied path with the service-role client.
 */
export function isOwnedStoragePath(path: string, ownerId: string): boolean {
  if (!ownerId || !path.startsWith(`${ownerId}/`)) return false;
  return !path.split("/").some((seg) => seg === ".." || seg === ".");
}
