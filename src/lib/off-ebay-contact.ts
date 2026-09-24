// OM-09: contact details in a buyer reply.
//
// eBay scans member messages for email addresses, phone numbers and links, and
// a seller who offers to "take it off eBay" can have the message blocked or the
// account flagged. Sellers usually do it innocently ("text me at ... for more
// photos"), so the reply box warns before Send rather than after eBay acts.
//
// Deliberately loose on the side of warning: a false alarm costs one extra
// click, a miss can cost the account. eBay's own links are not counted, since
// pointing a buyer at another listing is allowed.

export type OffEbayContactKind = "email" | "phone" | "link";

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
// Ten digits in the usual North American groupings, with an optional +1. A
// measurement ("22 x 30") or a price never has ten digits in a row like this.
const PHONE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const LINK = /\b(?:https?:\/\/|www\.)[^\s]+|\b[a-z0-9-]+\.(?:com|net|org|io|co|me|shop|store|app)\b(?:\/[^\s]*)?/gi;
const EBAY_HOST = /(?:^|[./])ebay\.[a-z.]+/i;

/** The kinds of off-eBay contact detail in `text`, in a fixed order. Pure. */
export function detectOffEbayContact(text: string): OffEbayContactKind[] {
  const out: OffEbayContactKind[] = [];
  // An email address also looks like a bare domain, so check it first and
  // strip it before looking for links.
  const hasEmail = EMAIL.test(text);
  if (hasEmail) out.push("email");
  if (PHONE.test(text)) out.push("phone");
  const withoutEmails = text.replace(new RegExp(EMAIL.source, "gi"), " ");
  const links = withoutEmails.match(LINK) ?? [];
  if (links.some((l) => !EBAY_HOST.test(l))) out.push("link");
  return out;
}

const NOUN: Record<OffEbayContactKind, string> = {
  email: "an email address",
  phone: "a phone number",
  link: "a link",
};

/** "an email address and a phone number", for the warning line. */
export function describeContact(kinds: OffEbayContactKind[]): string {
  const words = kinds.map((k) => NOUN[k]);
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
