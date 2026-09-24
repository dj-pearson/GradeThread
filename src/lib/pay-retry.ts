// SUB-09: which /api/grade/pay/:id answers are worth asking again.
//
// The retry loop exists to outrun the credit-grant webhook, which lands a beat
// after Stripe redirects the seller back. Only "not paid yet" (a 200 with
// payment.paid false), a network error, a timeout, a rate limit or a server
// hiccup can change on the next attempt. A refunded grade (409), a viewer
// (403), a missing submission (404) and grading switched off (503) are final,
// and asking eight times only delays telling the seller.

export function isFinalPayStatus(status: number): boolean {
  if (status === 503) return true;
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

export const PAY_RETRY_ATTEMPTS = 8;
export const PAY_RETRY_DELAY_MS = 2000;
