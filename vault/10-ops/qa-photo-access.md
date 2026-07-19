---
title: QA photo access
type: runbook
status: current
source_of_truth: vault
code_refs: []
reviewed: 2026-07-19
tags: [ops, qa, storage]
summary: How QA reaches submission images without breaking the private-bucket rule.
---
# QA Access to Customer Photos — Minimization, Consent & Retention Stance

> US-488. Customer-facing version: Privacy Policy §4.1 ("Human quality-assurance
> review") and DPA §2. This doc is the internal source of truth for what
> reviewers may see and the rules code must enforce. Changing the stance here
> means changing the policy pages AND `reliability-privacy.ts` together.

## Why this exists

Reliability studies and the human-review queue sample **real customer
submissions across all tenants**, so reviewer access is a deliberate exception
to "users only see their own data." That exception is acceptable only because
it is minimized, logged, and disclosed.

## The stance

**Purpose limitation.** Reviewer access to customer photos exists for exactly
three purposes: auditing low-confidence AI grades (human-review queue),
dispute investigation, and inter-rater reliability studies. Nothing else —
no marketing, no demos, no training-set screenshots.

**Consent basis.** QA review is part of providing/improving the Service:
covered by the ToS content license plus Privacy Policy §4.1 disclosure
(legitimate interest for EEA/UK). No separate per-photo consent is collected.
Users can object via privacy@gradethread.com; on objection, exclude the
user's submissions from future study sampling (objection does not affect
their grades or certificates).

**Minimization (enforced in code).** For reliability studies, the reviewer
payload is the allowlist in
`services/edge-functions/src/lib/reliability-privacy.ts`:

- garment photos (short-lived signed URLs, ≤ 900 s — US-276) plus
  `garment_type`, `garment_category`, `brand`, and the submission id;
- **never** owner identity (user_id, email, name);
- **never** seller-authored free text (`title`, `description`) — it can carry
  PII the seller typed, and it biases a blind grade;
- **never** `storage_path` (it embeds the owner's user UUID).

Widening the allowlist is a privacy-policy change, not just a code change.

**Access logging (enforced in code).** In `admin-grading.ts`:

- `view_reliability_queue` — one audit row per queue load (study, item count);
- `view_reliability_item` — one audit row **per item whose photos a reviewer
  opens** (reviewer, study, submission, image count, ip/user-agent via
  `writeAuditLog`).

Photo URLs are only issued through the per-item endpoint, which is scoped to
study membership — so there is no unlogged path to a sampled item's photos
inside the reliability surface.

**Retention.** QA reads photos **in place** — no copies. Studies persist only
numeric ratings + reviewer notes (`reliability_ratings`), which are kept as
de-identified research data. When a photo is purged (2-year auto-purge or
user deletion), it is gone from QA too; signed URLs expire within 15 minutes
regardless. Audit-log rows follow the platform audit-log retention, not the
photo's.

**Reviewer obligations.** Reviewers are staff/contractors bound by
confidentiality. No screenshots, downloads, or sharing of customer photos;
grade what you see, record a score, move on.
