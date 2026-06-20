// Amazon SNS message signature verification (US-914).
//
// The public /api/email/ses-notifications endpoint accepts unauthenticated SNS
// POSTs (SES bounce/complaint feedback + the subscription handshake). Anyone who
// knows the URL could otherwise forge a suppression for an arbitrary address (a
// deliverability DoS), so every message is signature-verified against the AWS
// signing certificate before we act on it.
//
// Verification (per the SNS docs):
//   1. SigningCertURL host must be sns.<region>.amazonaws.com over https — this
//      alone defeats forged certs (an attacker can't host one at amazonaws.com).
//   2. Build the canonical "string to sign" from the documented field set/order.
//   3. Fetch the cert, extract its RSA public key, and verify the base64
//      Signature (RSA-SHA1 for SignatureVersion 1, RSA-SHA256 for 2).
//
// The string-to-sign builder + cert-URL validator are pure (unit-tested without
// network). verifySnsSignature() does the fetch + RSA verify and FAILS CLOSED:
// anything it can't positively verify returns false.

import { captureException } from "./observability.ts";

export interface SnsMessage {
  Type?: string;
  MessageId?: string;
  Token?: string;
  TopicArn?: string;
  Message?: string;
  SubscribeURL?: string;
  Subject?: string;
  Timestamp?: string;
  SignatureVersion?: string;
  Signature?: string;
  SigningCertURL?: string;
  SigningCertUrl?: string;
  [k: string]: unknown;
}

// Documented signable field order per message type. "Subject" is included for
// Notification only when present.
const KEYS_NOTIFICATION = ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"];
const KEYS_SUBSCRIPTION = [
  "Message",
  "MessageId",
  "SubscribeURL",
  "Timestamp",
  "Token",
  "TopicArn",
  "Type",
];

/**
 * Build the canonical string to sign for an SNS message, or null if the type is
 * unknown or a required field is missing. Each field is emitted as
 * `key\nvalue\n` in the documented order.
 */
export function buildStringToSign(msg: SnsMessage): string | null {
  const type = msg.Type;
  let keys: string[];
  if (type === "Notification") keys = KEYS_NOTIFICATION;
  else if (type === "SubscriptionConfirmation" || type === "UnsubscribeConfirmation") {
    keys = KEYS_SUBSCRIPTION;
  } else return null;

  let out = "";
  for (const k of keys) {
    const v = (msg as Record<string, unknown>)[k];
    if (v === undefined || v === null) {
      // Subject is optional; any other missing required field means we can't
      // reconstruct the signed payload.
      if (k === "Subject") continue;
      return null;
    }
    out += `${k}\n${String(v)}\n`;
  }
  return out;
}

/** True iff the signing-cert URL is an https AWS SNS endpoint. */
export function isValidSigningCertUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  return /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(u.hostname);
}

function signingCertUrl(msg: SnsMessage): string | undefined {
  const url = msg.SigningCertURL ?? msg.SigningCertUrl;
  return typeof url === "string" ? url : undefined;
}

// Returns a standalone ArrayBuffer (a valid BufferSource) — the strict Deno lib
// rejects Uint8Array<ArrayBufferLike> for crypto.subtle args.
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64.trim());
  const ab = new ArrayBuffer(bin.length);
  const out = new Uint8Array(ab);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return ab;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  return new Uint8Array(base64ToArrayBuffer(b64));
}

// Read a DER length at `pos`; returns the length and the index of the first
// content byte.
function readLen(buf: Uint8Array, pos: number): { len: number; next: number } {
  let p = pos;
  const first = buf[p++]!;
  if (first < 0x80) return { len: first, next: p };
  const n = first & 0x7f;
  let len = 0;
  for (let i = 0; i < n; i++) len = (len << 8) | buf[p++]!;
  return { len, next: p };
}

function wrapSequence(content: Uint8Array): Uint8Array {
  const len = content.length;
  let header: number[];
  if (len < 0x80) header = [0x30, len];
  else if (len < 0x100) header = [0x30, 0x81, len];
  else header = [0x30, 0x82, (len >> 8) & 0xff, len & 0xff];
  const out = new Uint8Array(header.length + len);
  out.set(header, 0);
  out.set(content, header.length);
  return out;
}

// Extract the SubjectPublicKeyInfo (SPKI) DER from an X.509 RSA certificate by
// locating the rsaEncryption OID and rebuilding the enclosing SEQUENCE
// (AlgorithmIdentifier + BIT STRING). WebCrypto can importKey("spki", …) it.
function extractSpki(der: Uint8Array): Uint8Array | null {
  // rsaEncryption: 1.2.840.113549.1.1.1 → 06 09 2A 86 48 86 F7 0D 01 01 01
  const OID = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
  let oidPos = -1;
  for (let i = 0; i + OID.length <= der.length; i++) {
    let match = true;
    for (let j = 0; j < OID.length; j++) {
      if (der[i + j] !== OID[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      oidPos = i;
      break;
    }
  }
  if (oidPos < 0) return null;

  // AlgorithmIdentifier SEQUENCE header (`30 <len>`) sits immediately before the
  // OID (its content = OID + NULL, length < 0x80 → 1-byte length).
  const algSeqStart = oidPos - 2;
  if (algSeqStart < 0 || der[algSeqStart] !== 0x30) return null;
  const alg = readLen(der, algSeqStart + 1);
  const algEnd = alg.next + alg.len;
  if (der[algEnd] !== 0x03) return null; // BIT STRING (the public key)
  const bit = readLen(der, algEnd + 1);
  const bitEnd = bit.next + bit.len;
  if (bitEnd > der.length) return null;
  return wrapSequence(der.slice(algSeqStart, bitEnd));
}

/**
 * Verify an SNS message signature. Returns true only when the cert URL is a
 * valid AWS host AND the RSA signature over the canonical string-to-sign checks
 * out. Fails closed on any error.
 */
export async function verifySnsSignature(msg: SnsMessage): Promise<boolean> {
  const stringToSign = buildStringToSign(msg);
  if (!stringToSign) return false;
  const sig = msg.Signature;
  const certUrl = signingCertUrl(msg);
  if (typeof sig !== "string" || !certUrl) return false;
  if (!isValidSigningCertUrl(certUrl)) return false;

  let pem: string;
  try {
    const res = await fetch(certUrl);
    if (!res.ok) {
      await res.body?.cancel();
      return false;
    }
    pem = await res.text();
  } catch (err) {
    captureException(err, { route: "sns-verify.fetch_cert", level: "warn" });
    return false;
  }

  const spki = extractSpki(pemToDer(pem));
  if (!spki) return false;

  const hash = String(msg.SignatureVersion ?? "1") === "2" ? "SHA-256" : "SHA-1";
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      toArrayBuffer(spki),
      { name: "RSASSA-PKCS1-v1_5", hash },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64ToArrayBuffer(sig),
      new TextEncoder().encode(stringToSign),
    );
  } catch (err) {
    captureException(err, { route: "sns-verify.verify", level: "warn" });
    return false;
  }
}
