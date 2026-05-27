// Cloudflare R2 client. R2 is S3-compatible, so we use `aws4fetch` to
// build SigV4-signed requests against the R2 endpoint. No SDK install
// needed — aws4fetch is ~3KB and works directly with the runtime fetch.
//
// Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
//      R2_BUCKET, R2_PUBLIC_BASE_URL.

import { AwsClient } from "aws4fetch";

let cached: { client: AwsClient; endpoint: string; bucket: string; publicBase: string } | null =
  null;

function getR2Config() {
  if (cached) return cached;
  const accountId = Deno.env.get("R2_ACCOUNT_ID");
  const accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID");
  const secretAccessKey = Deno.env.get("R2_SECRET_ACCESS_KEY");
  const bucket = Deno.env.get("R2_BUCKET");
  const publicBase = Deno.env.get("R2_PUBLIC_BASE_URL");

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket || !publicBase) {
    throw new Error(
      "R2 is not configured. Required env vars: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_BASE_URL.",
    );
  }

  const client = new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  cached = {
    client,
    endpoint,
    bucket,
    publicBase: publicBase.replace(/\/$/, ""),
  };
  return cached;
}

export function isR2Configured(): boolean {
  try {
    getR2Config();
    return true;
  } catch {
    return false;
  }
}

// PUT an object into R2. `body` can be a Blob, ArrayBuffer, or Uint8Array.
export async function putR2Object(
  key: string,
  body: BodyInit,
  contentType?: string,
): Promise<void> {
  const { client, endpoint, bucket } = getR2Config();
  const url = `${endpoint}/${bucket}/${encodeR2Key(key)}`;
  const headers: HeadersInit = {};
  if (contentType) headers["Content-Type"] = contentType;
  const res = await client.fetch(url, {
    method: "PUT",
    headers,
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`R2 PUT failed (${res.status}): ${text.slice(0, 300)}`);
  }
}

// HEAD an object — used as a post-upload integrity check before we delete
// the source on Supabase.
export async function headR2Object(key: string): Promise<{ size: number } | null> {
  const { client, endpoint, bucket } = getR2Config();
  const url = `${endpoint}/${bucket}/${encodeR2Key(key)}`;
  const res = await client.fetch(url, { method: "HEAD" });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`R2 HEAD failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const len = Number(res.headers.get("content-length") ?? 0);
  return { size: Number.isFinite(len) ? len : 0 };
}

export function r2PublicUrl(key: string): string {
  const { publicBase } = getR2Config();
  return `${publicBase}/${encodeR2Key(key)}`;
}

// Path-style keys must percent-encode unsafe chars but NOT slashes (R2
// preserves the folder hierarchy verbatim).
function encodeR2Key(key: string): string {
  return key
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}
