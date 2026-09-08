// US-3159: the provider-shaped half of cloud folder import.
//
// Everything here is pure — a listing entry turned into a CloudEntry, a
// filename judged importable, a hostname judged ours. No stack, no network, and
// no Deno.env beyond the two the auth-URL case sets itself.

import { assert, assertEquals } from "@std/assert";
import {
  CLOUD_PROVIDER_IDS,
  configuredCloudProviders,
  countUnreadable,
  dropboxEntryToCloudEntry,
  dropboxProvider,
  oneDriveProvider,
  getCloudProvider,
  graphItemToCloudEntry,
  isCloudProviderId,
  isImportableName,
  isUnreadableImageName,
} from "../lib/cloud-folder-providers.ts";

Deno.test("a Dropbox folder entry becomes a navigable folder", () => {
  const e = dropboxEntryToCloudEntry({
    ".tag": "folder",
    id: "id:abc",
    name: "Camera Uploads",
    path_lower: "/camera uploads",
  });
  assertEquals(e?.kind, "folder");
  assertEquals(e?.path, "/camera uploads");
  assertEquals(e?.capturedAtMs, null);
});

Deno.test("a Dropbox photo carries the date the camera wrote, not the sync time", () => {
  const e = dropboxEntryToCloudEntry({
    ".tag": "file",
    id: "id:def",
    name: "IMG_0042.JPG",
    path_lower: "/camera uploads/img_0042.jpg",
    size: 2_400_000,
    client_modified: "2026-03-04T10:11:12Z",
    server_modified: "2026-09-01T00:00:00Z",
  });
  assertEquals(e?.kind, "file");
  assertEquals(e?.sizeBytes, 2_400_000);
  assertEquals(e?.capturedAtMs, Date.parse("2026-03-04T10:11:12Z"));
});

Deno.test("a file the import core cannot read is dropped from the listing", () => {
  // The core validates by magic bytes and allows jpeg, png and webp only, so a
  // HEIC listed here would just fail later with no explanation.
  for (const name of ["IMG_1.HEIC", "scan.tiff", "notes.txt", "clip.mov", "noextension"]) {
    assertEquals(
      dropboxEntryToCloudEntry({ ".tag": "file", name, path_lower: `/x/${name}` }),
      null,
      `${name} should not be listed as importable`,
    );
  }
});

Deno.test("an entry with no name or no path is dropped rather than half-built", () => {
  assertEquals(dropboxEntryToCloudEntry({ ".tag": "file", name: "a.jpg" }), null);
  assertEquals(dropboxEntryToCloudEntry({ ".tag": "file", path_lower: "/a.jpg" }), null);
  assertEquals(dropboxEntryToCloudEntry({ ".tag": "deleted", name: "a.jpg", path_lower: "/a.jpg" }), null);
});

Deno.test("importable and unreadable are different questions", () => {
  assert(isImportableName("a.JPEG"));
  assert(isImportableName("a.webp"));
  assert(!isImportableName("a.heic"));
  assert(!isImportableName("a"));
  // A HEIC is an image we cannot read; a .txt is not an image at all, and
  // counting it would tell the seller their folder has photos it does not.
  assert(isUnreadableImageName("a.HEIC"));
  assert(isUnreadableImageName("a.dng"));
  assert(!isUnreadableImageName("a.txt"));
  assert(!isUnreadableImageName("a.jpg"));
  assertEquals(
    countUnreadable([{ name: "a.jpg" }, { name: "b.heic" }, { name: "c.tiff" }, { name: "d.txt" }]),
    2,
  );
});

Deno.test("only a real Dropbox download host is allowed", () => {
  assert(dropboxProvider.allowHost("dropboxusercontent.com"));
  assert(dropboxProvider.allowHost("uc1234.dropboxusercontent.com"));
  // The look-alike that a naive `includes` or a dotless `endsWith` would pass.
  assert(!dropboxProvider.allowHost("evildropboxusercontent.com"));
  assert(!dropboxProvider.allowHost("dropboxusercontent.com.attacker.test"));
  assert(!dropboxProvider.allowHost("api.dropboxapi.com"));
});

Deno.test("the consent URL asks for offline access and the two read scopes", () => {
  const had = Deno.env.get("DROPBOX_CLIENT_ID");
  Deno.env.set("DROPBOX_CLIENT_ID", "test-client");
  try {
    const url = new URL(dropboxProvider.buildAuthUrl("st-1", "https://edge.test/cb"));
    assertEquals(url.origin + url.pathname, "https://www.dropbox.com/oauth2/authorize");
    assertEquals(url.searchParams.get("state"), "st-1");
    assertEquals(url.searchParams.get("redirect_uri"), "https://edge.test/cb");
    // Without token_access_type=offline Dropbox returns no refresh token and the
    // grant dies in four hours.
    assertEquals(url.searchParams.get("token_access_type"), "offline");
    const scope = url.searchParams.get("scope") ?? "";
    assert(scope.includes("files.metadata.read"));
    assert(scope.includes("files.content.read"));
    // Nothing that can write. A stolen grant must not be able to alter the
    // seller's Dropbox.
    assert(!scope.includes("write"));
  } finally {
    if (had === undefined) Deno.env.delete("DROPBOX_CLIENT_ID");
    else Deno.env.set("DROPBOX_CLIENT_ID", had);
  }
});

Deno.test("the registry names every provider and hands back only the built ones", () => {
  assertEquals([...CLOUD_PROVIDER_IDS], ["dropbox", "onedrive"]);
  assert(isCloudProviderId("dropbox"));
  assert(!isCloudProviderId("gdrive"));
  assertEquals(getCloudProvider("dropbox")?.id, "dropbox");
  assertEquals(getCloudProvider("onedrive")?.id, "onedrive");
  for (const p of configuredCloudProviders()) assert(p.isConfigured());
});

Deno.test("an unconfigured deploy offers nothing rather than a button that cannot work", () => {
  const hadId = Deno.env.get("DROPBOX_CLIENT_ID");
  const hadSecret = Deno.env.get("DROPBOX_CLIENT_SECRET");
  Deno.env.delete("DROPBOX_CLIENT_ID");
  Deno.env.delete("DROPBOX_CLIENT_SECRET");
  try {
    assert(!dropboxProvider.isConfigured());
    assertEquals(configuredCloudProviders().length, 0);
  } finally {
    if (hadId !== undefined) Deno.env.set("DROPBOX_CLIENT_ID", hadId);
    if (hadSecret !== undefined) Deno.env.set("DROPBOX_CLIENT_SECRET", hadSecret);
  }
});

// ── OneDrive (US-3160) ──────────────────────────────────────────────

Deno.test("a Graph folder becomes a navigable folder addressed by item id", () => {
  const e = graphItemToCloudEntry({ id: "01ABC!123", name: "Camera Roll", folder: { childCount: 9 } });
  assertEquals(e?.kind, "folder");
  // The path IS the item id. Graph has no slash-delimited address, which is
  // why nothing on the client parses a path.
  assertEquals(e?.path, "01ABC!123");
});

Deno.test("a Graph photo prefers the shutter time over the sync time", () => {
  const e = graphItemToCloudEntry({
    id: "01DEF!456",
    name: "IMG_0042.JPG",
    size: 3_100_000,
    file: { mimeType: "image/jpeg" },
    photo: { takenDateTime: "2026-03-04T10:11:12Z" },
    fileSystemInfo: { createdDateTime: "2026-09-01T00:00:00Z" },
  });
  assertEquals(e?.kind, "file");
  assertEquals(e?.sizeBytes, 3_100_000);
  assertEquals(e?.capturedAtMs, Date.parse("2026-03-04T10:11:12Z"));
});

Deno.test("a Graph photo with no shutter time falls back rather than losing the date", () => {
  const e = graphItemToCloudEntry({
    id: "01GHI!789",
    name: "scan.png",
    file: {},
    fileSystemInfo: { createdDateTime: "2026-05-05T05:05:05Z" },
  });
  assertEquals(e?.capturedAtMs, Date.parse("2026-05-05T05:05:05Z"));
});

Deno.test("a Graph item that is neither a folder nor a readable file is dropped", () => {
  assertEquals(graphItemToCloudEntry({ id: "x", name: "IMG.HEIC", file: {} }), null);
  assertEquals(graphItemToCloudEntry({ id: "x", name: "notes.txt", file: {} }), null);
  // Neither folder nor file: a Graph item can be a package or a bundle.
  assertEquals(graphItemToCloudEntry({ id: "x", name: "thing" }), null);
  assertEquals(graphItemToCloudEntry({ name: "a.jpg", file: {} }), null);
});

Deno.test("only a Microsoft download host is allowed", () => {
  // Work accounts answer on the tenant's SharePoint host, personal ones on 1drv.
  assert(oneDriveProvider.allowHost("contoso-my.sharepoint.com"));
  assert(oneDriveProvider.allowHost("public.bl.files.1drv.com"));
  assert(oneDriveProvider.allowHost("my.onedrive.com"));
  assert(!oneDriveProvider.allowHost("evilsharepoint.com"));
  assert(!oneDriveProvider.allowHost("sharepoint.com.attacker.test"));
  assert(!oneDriveProvider.allowHost("graph.microsoft.com"));
});

Deno.test("the OneDrive consent URL asks for Files.Read and offline access only", () => {
  const had = Deno.env.get("MICROSOFT_CLIENT_ID");
  Deno.env.set("MICROSOFT_CLIENT_ID", "test-client");
  try {
    const url = new URL(oneDriveProvider.buildAuthUrl("st-2", "https://edge.test/cb"));
    assertEquals(
      url.origin + url.pathname,
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    assertEquals(url.searchParams.get("state"), "st-2");
    const scope = url.searchParams.get("scope") ?? "";
    assert(scope.includes("Files.Read"));
    assert(scope.includes("offline_access"));
    // Nothing that can write, and no profile scope: the account label comes
    // from the id token the grant already returns.
    assert(!scope.includes("Files.ReadWrite"));
    assert(!scope.includes("User.Read"));
  } finally {
    if (had === undefined) Deno.env.delete("MICROSOFT_CLIENT_ID");
    else Deno.env.set("MICROSOFT_CLIENT_ID", had);
  }
});

Deno.test("the env prefix is the app the operator actually registered", () => {
  assertEquals(dropboxProvider.envPrefix, "DROPBOX");
  // Not ONEDRIVE: the same Microsoft app registration also covers Outlook and
  // Teams, and naming the variables after one of its products would mislead
  // whoever has to find them again.
  assertEquals(oneDriveProvider.envPrefix, "MICROSOFT");
});
