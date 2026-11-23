# Release button — spec (owner order 2026-11-23 ~13:37 EST)

## What he said (his words, kept tight)
- A talent takes listings; they sit on her profile (e.g. Mona Lisa takes 4).
- Something comes up and she can't make one → she presses RELEASE on that one.
- The release notifies the agency she won't be available.
- It has to be 72 hours before (the release must happen at least 72h before the booking).
- Once released: it erases off her page, and an email goes to that particular agency saying she won't make it "due to certain circumstances".
- The email is ONE Top Tea Talents template for everyone; only the talent's name and the agency name change per email.

## Surfaces (verified in code 2026-11-23)
- Talent's Applications screen: `frontend/app.js` `screenApplications`, route `#/applications`, GET `/api/v1/applications?talentId=`. This is where the talent sees her listings.
- Bookings: server `bookings` table, status `BOOKED` / `COMPLETED` (`server/src/server.ts:635,642`). The release applies to a BOOKED booking.
- Mailer: `buildApplicationEmail` is the one email builder (`server/src/server.ts:2958`); queue + `drainOneEmail` + POST `/email/drain` (`server.ts:2230,3032`). The release email is a second builder (`buildReleaseEmail`) on the same queue/drain path — same discipline (never invents a pay figure or a link).

## Flow
1. Talent opens her Applications/bookings view; each BOOKED booking carries a Release button.
2. Press Release → one-tap confirm (no silent destructive action) → backend checks the 72h rule: `bookingDate − now ≥ 72h`.
   - Inside 72h: release REFUSED with a plain message — contact the agency directly. The button does not send a late release on its own. (His rule: "it has to be 72 hours before.")
   - At or beyond 72h: booking status → `RELEASED` (new status), `releasedAt` recorded, booking disappears from her page (her view filters out RELEASED).
3. Backend enqueues the release email to THAT agency (the booking's agency/production contact — the same destination resolution as application emails; never a platform support address) and drains it through the existing mailer.
4. Email = the one Top Tea Talents release template: talent name + agency name swapped per email, nothing else varies. Body: she won't be available for [booking title/date] due to certain circumstances; agency contact for follow-up. No invented details.
5. Ledger event recorded (release + email sent), visible in the mirror; admin sees it in the applications/bookings view.

## Open design points (builder confirms against the code)
- Booking date: the 72h check needs a concrete date on the booking row. If bookings carry no event/filming date, take it from the opportunity or add one — a release with no date cannot be checked and is blocked.
- Talent access: she presses it herself, from her own view. Talent session already exists on the site (`sessionTalentId` in `app.js`) — the release endpoint must check the caller IS that talent (or an admin acting for her).
- "Certain circumstances" line: fixed template wording, no per-release free text in v1 (his spec: template, names only).
- Late release (inside 72h): refused by the button; the agency-contact path is a message, not a second button.

## Build order
- Queues behind the lorddvrris teaser v2 (one-by-one law — one build at a time).
- Builder: backend endpoint POST `/api/v1/bookings/:id/release` + `buildReleaseEmail` + frontend button on `#/applications` (BOOKED rows) + 72h rule + RELEASED status + ledger event.
- Verify live: release a test booking ≥72h out, confirm it vanishes from the talent view, confirm the agency email lands in the queue and sends, confirm an inside-72h release refuses.
