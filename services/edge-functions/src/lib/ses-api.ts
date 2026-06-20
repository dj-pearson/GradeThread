// US-915: Amazon SES v2 HTTP API transport (SendEmail) with SigV4 signing via
// aws4fetch. Preferred for marketing volume because the request carries the
// Configuration Set name (so SES publishes bounce/complaint/delivery events to
// the wired SNS destination) and arbitrary message headers (List-Unsubscribe /
// List-Unsubscribe-Post for one-click unsubscribe), which the SMTP path can also
// set but the API makes first-class.
//
// Credentials/region come from SES_AWS_* (falling back to the standard AWS_*
// names). Any failure returns false so the caller falls back to SMTP — a bug in
// this path can never silently drop mail.

import { AwsClient } from "aws4fetch";
import { captureException } from "./observability.ts";

export interface SesApiSendParams {
  /** RFC 5322 From, e.g. `GradeThread News <news@news.gradethread.com>`. */
  from: string;
  to: string;
  subject: string;
  html: string;
  /** Plaintext alternative (improves deliverability); optional. */
  text?: string;
  replyTo?: string;
  configurationSet?: string;
  /** Extra message headers (List-Unsubscribe, …). */
  headers?: Record<string, string>;
}

interface SesCreds {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

function readCreds(): SesCreds | null {
  const get = (k: string) => Deno.env.get(k)?.trim() || undefined;
  const region = get("SES_AWS_REGION") ?? get("AWS_REGION");
  const accessKeyId = get("SES_AWS_ACCESS_KEY_ID") ?? get("AWS_ACCESS_KEY_ID");
  const secretAccessKey = get("SES_AWS_SECRET_ACCESS_KEY") ?? get("AWS_SECRET_ACCESS_KEY");
  if (!region || !accessKeyId || !secretAccessKey) return null;
  const sessionToken = get("SES_AWS_SESSION_TOKEN") ?? get("AWS_SESSION_TOKEN");
  return { region, accessKeyId, secretAccessKey, sessionToken };
}

/**
 * Build the SES v2 SendEmail request body. Exported (pure) so the payload shape
 * is unit-testable without signing/network.
 */
export function buildSesSendBody(params: SesApiSendParams): Record<string, unknown> {
  const body: Record<string, unknown> = {
    FromEmailAddress: params.from,
    Destination: { ToAddresses: [params.to] },
    Content: {
      Simple: {
        Subject: { Data: params.subject, Charset: "UTF-8" },
        Body: {
          Html: { Data: params.html, Charset: "UTF-8" },
          ...(params.text ? { Text: { Data: params.text, Charset: "UTF-8" } } : {}),
        },
        ...(params.headers && Object.keys(params.headers).length > 0
          ? {
            Headers: Object.entries(params.headers).map(([Name, Value]) => ({ Name, Value })),
          }
          : {}),
      },
    },
  };
  if (params.replyTo) body.ReplyToAddresses = [params.replyTo];
  if (params.configurationSet) body.ConfigurationSetName = params.configurationSet;
  return body;
}

/**
 * Send one email via the SES v2 HTTP API. Returns true iff SES accepted it
 * (2xx). On any error (no creds, network, non-2xx) returns false so the caller
 * falls back to SMTP.
 */
export async function sendViaSesApi(params: SesApiSendParams): Promise<boolean> {
  const creds = readCreds();
  if (!creds) return false;

  const aws = new AwsClient({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
    region: creds.region,
    service: "ses",
  });
  const url = `https://email.${creds.region}.amazonaws.com/v2/email/outbound-emails`;

  try {
    const res = await aws.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildSesSendBody(params)),
    });
    if (res.ok) {
      // Drain the body so the connection is released.
      await res.body?.cancel();
      console.log(`[Email/SES] Sent via SES API to ${params.to}`);
      return true;
    }
    const detail = await res.text().catch(() => "");
    captureException(new Error(`SES API ${res.status}: ${detail.slice(0, 500)}`), {
      route: "email.ses-api",
      tags: { status: String(res.status) },
    });
    console.error(`[Email/SES] SES API rejected send (${res.status}) — falling back to SMTP`);
    return false;
  } catch (error) {
    captureException(error, { route: "email.ses-api" });
    console.error(
      "[Email/SES] SES API send threw — falling back to SMTP:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

/** Minimal HTML → plaintext for the SES API text alternative (SMTP uses denomailer's "auto"). */
export function htmlToPlainText(html: string): string {
  return (html ?? "")
    .replace(/<br\s*\/?>(?=\s*)/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&copy;/gi, "©")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
