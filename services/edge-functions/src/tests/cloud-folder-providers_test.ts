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
  getCloudProvider,
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
  // US-3160 fills this in. Until then the id is known and the provider is not,
  // which is what keeps the route answering 404 rather than throwing.
  assertEquals(getCloudProvider("onedrive"), null);
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
