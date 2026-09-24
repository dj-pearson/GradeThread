// AL-02: one strict answer to "is this storage path inside the caller's own
// folder?".
//
// Routes used to check `path.startsWith(`${ownerId}/_staging/`)`, which a path
// like `owner/_staging/../../victim/x.jpg` passes. Storage and the signed-URL
// endpoints normalise `..`, so the model was handed another tenant's photo. A
// prefix check is only a tenancy check when the rest of the path cannot climb
// back out of the prefix, so this rejects every shape that could:
//   - an empty, "." or ".." segment, in the raw path OR its percent-decoding
//   - a backslash, "%", "?", "#" or any control character anywhere
//
// "%" is refused outright rather than decoded-and-rechecked because a path the
// app wrote itself never contains one (uuid / timestamp / ext only), and a
// double-encoded `%252e%252e` would otherwise survive one decode.

function hasForbiddenChar(path: string): boolean {
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
    const ch = path[i];
    if (ch === "\\" || ch === "%" || ch === "?" || ch === "#") return true;
  }
  return false;
}

function hasUnsafeSegment(path: string): boolean {
  return path.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
}

/**
 * True when `path` is a plain relative path strictly below `${prefix}` (which
 * must end with "/") with no segment that could climb out of it.
 */
function isSafeUnder(path: unknown, prefix: string): path is string {
  if (typeof path !== "string" || !prefix.endsWith("/")) return false;
  if (!path.startsWith(prefix) || path.length === prefix.length) return false;
  if (hasForbiddenChar(path)) return false;
  if (hasUnsafeSegment(path)) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  if (decoded !== path && (hasForbiddenChar(decoded) || hasUnsafeSegment(decoded))) {
    return false;
  }
  return true;
}

/** Is `path` a staged object inside `${ownerId}/_staging/`? */
export function isOwnedStagingPath(path: unknown, ownerId: string): path is string {
  if (!ownerId || ownerId.includes("/")) return false;
  return isSafeUnder(path, `${ownerId}/_staging/`);
}

/** Is `path` any object inside the `${ownerId}/` folder? */
export function isOwnedStoragePath(path: unknown, ownerId: string): path is string {
  if (!ownerId || ownerId.includes("/")) return false;
  return isSafeUnder(path, `${ownerId}/`);
}
