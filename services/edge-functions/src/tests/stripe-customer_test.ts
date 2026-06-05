// US-391: single Stripe customer per user — reconciliation + idempotency key.
import { assertEquals } from "@std/assert";
import {
  customerCreateIdempotencyKey,
  reconcileCustomerLink,
} from "../lib/stripe-customer.ts";

Deno.test("reconcileCustomerLink: set when no customer is linked yet", () => {
  assertEquals(reconcileCustomerLink(null, "cus_A"), "set");
  assertEquals(reconcileCustomerLink("", "cus_A"), "set");
});

Deno.test("reconcileCustomerLink: noop when the stored id already matches", () => {
  assertEquals(reconcileCustomerLink("cus_A", "cus_A"), "noop");
});

Deno.test("reconcileCustomerLink: conflict when a DIFFERENT customer is linked", () => {
  // A duplicate customer must not silently repoint the user — flag it.
  assertEquals(reconcileCustomerLink("cus_A", "cus_B"), "conflict");
});

Deno.test("customerCreateIdempotencyKey is stable per user (race → one customer)", () => {
  assertEquals(customerCreateIdempotencyKey("u1"), "customer-create:u1");
  // Same user → same key, so concurrent first-checkout creates dedupe at Stripe.
  assertEquals(
    customerCreateIdempotencyKey("u1"),
    customerCreateIdempotencyKey("u1"),
  );
  // Distinct users → distinct keys.
  const a = customerCreateIdempotencyKey("u1");
  const b = customerCreateIdempotencyKey("u2");
  assertEquals(a === b, false);
});
