// US-2121: the seller signup path enrols the account in a 14-day Pro trial
// server-side (handle_new_user). ROSCA / state auto-renewal laws require the
// trial to be disclosed at the point of enrolment. These tests pin that the
// disclosure renders on the seller signup screen — covering length, no-card,
// and the positively-stated no-charge outcome — and that it is ABSENT on the
// buyer variant (intent=buyer), which is provisioned free/none with no trial.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SignupPage } from "@/pages/signup";

function render(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <SignupPage />
        </MemoryRouter>
      </QueryClientProvider>
  );
}

describe("US-2121 signup trial disclosure", () => {
  it("discloses the 14-day Pro trial on the seller signup screen", () => {
    const html = render("/signup");
    // Length + that a trial is being started.
    expect(html).toMatch(/14-day free Pro trial/i);
    // No card required.
    expect(html).toMatch(/No credit card required/i);
    // What happens at the end, stated positively (switches to Free, no charge).
    expect(html).toMatch(/switches to the free plan/i);
    expect(html).toMatch(/never charged/i);
  });

  it("does NOT show trial copy on the buyer signup variant (no trial granted)", () => {
    const html = render("/signup?intent=buyer");
    expect(html).not.toMatch(/free Pro trial/i);
    expect(html).not.toMatch(/No credit card required/i);
  });
});
