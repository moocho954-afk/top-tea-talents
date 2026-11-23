# Release button — build report (2026-11-23, owner order ~13:37 EST)

## What was built
- **POST /api/v1/bookings/:id/release** (`server/src/server.ts`, in the bookings block).
  Auth: the talent herself (session token) or admin (`requireTalentOrAdmin`).
  Only a BOOKED / BOOKING CONFIRMED booking can be released. On success the
  booking goes to status `RELEASED`, `released_at` is recorded, the talent gets
  an in-app notification, and the release email is queued + drained on the
  normal mailer path. Refusals change nothing.
- **72-hour rule, server-side.** The event date resolves in order: the
  `event_date` stored on the booking row (new optional `eventDate` on booking
  create, YYYY-MM-DD, validated) → the earliest date token in the
  opportunity's `production_dates` (existing `extractDateTokens`, e.g. "Shoot
  dates: January 5 to January 7" → 2026-01-05). The application deadline is
  NEVER used as the event date. No date anywhere → the release is blocked
  ("No event date on file … the 72-hour rule cannot be checked").
  Inside 72h → refused with the hours remaining ("Too late to release online
  — this booking starts in N hours, inside the 72-hour window. Contact the
  agency directly."). The event is treated as starting at 00:00 UTC on the
  event date; the response carries `eventDate`, `eventDateSource` and
  `hoursUntilEvent` so the math is visible.
- **buildReleaseEmail — the ONE template.** Only the talent's name and the
  agency name vary; title/date/location are facts from the record. No
  per-release free text in v1. Destination resolves exactly like application
  emails (`resolveDestination`: listing contact_email/instructions first,
  then the contacts table by org). Platform support addresses are refused as
  destinations (same 6-address blocklist as contacts). No agency email on
  file → the release still processes, no email is queued, and the response
  says so plainly.
- **GET /api/v1/bookings** now enriches each row with `eventDate`,
  `eventDateSource`, `hoursUntilEvent`. `bookingView` exposes `eventDate` /
  `releasedAt`. Schema: `bookings` gains `event_date` + `released_at`
  (schema.sql + idempotent `migrateReleaseV131`, same pattern as
  `migrateMailV13`).
- **Frontend** (`frontend/app.js`): shared `releaseBookingHTML` +
  `wireReleaseButtons` helpers. A Release button (`btn btn-danger`) on every
  BOOKED booking on **#/bookings** AND on a new "Your bookings" section of
  **#/applications**, with the 72h rule shown ("Releases must be made at
  least 72 hours before the booking") and a native `confirm()` step (house
  style for destructive actions). RELEASED bookings never render on the
  talent side. `dryRun: true` previews the exact email + the 72h math without
  changing anything (same discipline as the send endpoint).
- Ledger: `audit("booking.release", …)` on every release (visible in the mirror).

## Verification (local scratch server, :3101, scratch SQLite DB — 36/36)
Test: `tools/release-button-test.py` (re-runnable against a local server).
- Static: `tsc --noEmit` clean, `node --check app.js` clean, existing
  frontend unit tests 34/34 pass; release-button render harness 10/10
  (button id, btn-danger, 72h text, date + hours shown, no button for
  COMPLETED, RELEASED filtered out, confirm step, correct POST path).
- 72h both ways: far booking (2026-12-03) released; near booking
  (2026-11-24, ~24h out) refused with the 72h message and stayed BOOKED;
  no-date booking blocked and stayed BOOKED; opportunity-derived date
  (2026-12-05 from production_dates) released.
- Auth: another talent → 403, no token → 401, missing booking → 404,
  re-release → 400 "already released".
- Email: 2 release emails QUEUED to the test agency address with the exact
  template text (verbatim body in the test output). Drain ran and honestly
  reported `TEST MODE: sending disabled`; the emails stayed QUEUED — the
  drain path is exercised, the send is blocked by config, not by code.
- Audit: 2 `booking.release` events; 2 release notifications to the talent.

## NOT yet proven (needs the parent's deploy)
- The live Gmail send. Local mail is unconfigured by design, so the live
  drain proof must run on the deployed backend: create a scratch
  talent + scratch opportunity (contact_email = topteatalents@gmail.com, the
  agency's own mailbox as the controlled test destination — no real agency)
  + application + booking with an event date ≥72h out, release it, confirm
  the email_queue row goes SENT with a Gmail message id, then remove the
  scratch records. Live has 0 bookings today, so nothing real is at risk.
- Live health baseline (checked 2026-11-23 ~15:5x EST, pre-deploy):
  ok:true, v1.3.1, live_mode:true, mail_configured:true,
  submissions_paused:false, 434 opportunities, 4 talents, 19 applications,
  0 bookings. Re-check after deploy.

## Files changed
- `server/src/server.ts` — release endpoint, buildReleaseEmail, date
  resolution, bookingView, booking create (eventDate), GET enrichment,
  migrateReleaseV131.
- `server/src/schema.sql` — bookings.event_date, bookings.released_at.
- `frontend/app.js` — release helpers, button on #/bookings and
  #/applications.
- `tools/release-button-test.py` — the local end-to-end test (new).
