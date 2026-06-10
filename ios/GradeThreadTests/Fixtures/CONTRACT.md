# iOS ↔ Edge wire contract (US-793)

The canonical shape of the edge responses the iOS app decodes, plus the valid
enum values per field. Captured JSON fixtures live next to this file; both sides
test against them so drift fails CI on whichever side moved.

## Tolerant enum decoding (the rule)

Server-introduced enum values must **degrade one label, never fail the whole
decode**. iOS decodes enum-like fields through `Tolerant<T>`
(`ios/GradeThread/Networking/Tolerant.swift`): a known case decodes to
`.known(T)`, an unrecognized value to `.unknown(rawValue)`. UI renders `.unknown`
sensibly (e.g. the raw string, or a neutral "—"). Add new server values freely;
old app builds keep working.

> Migration status: `Tolerant<T>` + its unit tests are in place. Applying it to
> every existing DTO enum field (the `status` properties below) is an
> in-progress sweep that must be compiled on a Mac / iOS CI (Swift can't build on
> the Windows dev box — see CLAUDE.md). New DTOs should adopt `Tolerant<T>` from
> the start.

## Response shapes + enum domains

### Grading submit — `POST /api/flipdesk/grading/submit`
- `ok: Bool` (required). On `ok == true`, `submission_id: String` is **required**
  (enforce with a throwing accessor / split success struct — don't model it as
  optional and silently no-op).

### Grading status — `GET /api/grade/status/:id`
- `status` ∈ `pending | processing | completed | failed | needs_photos | expired`
  (US-773 added `expired`). Decode tolerantly.
- `payment_status` ∈ `unpaid | included | credits | paid_stripe`.

### AutoLister batch — `GET /api/flipdesk/autolister/batch/:id`
- `batch.status` ∈ `queued | processing | completed | partial | failed`.
- `jobs[].status` ∈ `queued | processing | completed | failed`.

### Reconciliation queue — `GET /api/flipdesk/reconciliation/queue`
- Paginated (US-793): `{ queue: [...], total: Int, showing: Int, has_more: Bool, limit: Int }`.
  iOS surfaces "showing first N of M" when `has_more` — never silently truncates.

### Negotiation offers — `GET /api/flipdesk/ebay/negotiation/eligible`
- Offer `status`/eligibility flags decode tolerantly.

### Disclosure item — `GET /api/flipdesk/disclosure/:id`
- Photo `role` ∈ `front | back | tag | detail | defect | flatlay` (+ measurement
  roles). Decode tolerantly.

### App Store verify — `POST /api/appstore/verify`
- `environment` ∈ `Sandbox | Production`. `status` codes per Apple. Decode tolerantly.

## Drift guard

- **Edge side:** `src/tests/*` shape tests assert each handler still produces the
  documented field set (e.g. `flipdesk-reconciliation-shape_test.ts`).
- **iOS side:** `GradeThreadTests/*` decode the captured fixtures here and assert
  the typed model round-trips (run on iOS CI / macOS).
