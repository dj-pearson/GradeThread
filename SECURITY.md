# Security Policy

GradeThread is operated by Pearson Media LLC. We take the security of the
platform and our users' data seriously.

## Reporting a vulnerability

Please report security issues privately — **do not open a public GitHub issue**.

- Email: **security@gradethread.com**
- Include: a description, steps to reproduce, affected URL/endpoint, and the
  impact you believe it has. A proof-of-concept helps us triage faster.
- We aim to acknowledge reports within **3 business days** and to provide a
  remediation timeline after triage.

### Safe harbor

We will not pursue legal action against researchers who:
- act in good faith and avoid privacy violations, data destruction, and service
  degradation;
- only interact with accounts they own or have explicit permission to test;
- give us reasonable time to remediate before public disclosure;
- do not exfiltrate more data than necessary to demonstrate the issue.

### Out of scope

Reports that typically do not qualify: missing best-practice headers without a
demonstrated impact, rate-limiting on non-sensitive endpoints, social
engineering, physical attacks, and findings only reproducible with outdated or
rooted devices.

## Supported versions

GradeThread is a continuously deployed SaaS — only the **currently deployed
production version** (`main`) is supported. There are no maintained release
branches.

## Our security posture (summary)

- Self-hosted Supabase with Row Level Security on all multi-tenant tables;
  users access only their own data.
- The edge service verifies the caller's JWT before any privileged work; admin
  endpoints additionally check the `admin`/`super_admin` role server-side.
- Marketplace OAuth tokens are encrypted at rest (AES-256-GCM).
- Stripe and eBay webhooks verify HMAC signatures and are idempotent.
- Secrets are scanned in CI (gitleaks) and pre-commit; production debug bypasses
  fail closed.

## Related internal docs

- [Incident response runbook](vault/10-ops/incident-response.md)
- [Key & secret rotation runbook](vault/10-ops/key-rotation.md)
