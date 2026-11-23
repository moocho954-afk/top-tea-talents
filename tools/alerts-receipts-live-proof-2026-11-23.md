# TTT Talent Alerts + Receipts — LIVE GMAIL PROOF (v1.3.2)

Built 2026-11-23, deployed live (health ok:true, version 1.3.2, live_mode:true,
mail_configured:true, submissions_paused:false). Proof run 2026-11-23 ~16:44–16:47 EST.
**Status: PROVEN LIVE for all three new emails + the answers round-trip.**
One real defect found (the form link in the alert email 404s — see Finding 1).
One leftover contact row that has no delete route (Finding 4).

## Scratch records used (all deleted — see Cleanup)

- Talent: tal_29ff23899bc84502 "Test Proof", email topteatalents@gmail.com
  (fresh registration; the agency mailbox is the only inbox this proof could
  read, so the scratch talent carried it — see Finding 2 for the side effect).
- Opportunity 1: test:alerts-proof-20261123 "TEST — Alerts Proof Print Role",
  $500/day, event 2026-12-03, contact topteatalents@gmail.com.
- Opportunity 2: test:alerts-proof-callback-20261123 "TEST — Alerts Proof
  Callback Role", $400/day, event 2026-12-05, contact topteatalents@gmail.com.
- Application 1: app_4a078509aee9434a (opp 1). Application 2: app_14044bae9e2b4f63 (opp 2).
- Booking: bkg_2dcd943697b64633 (created by the accepted outcome, released +
  deleted during cleanup).

Joseph, Mona Lisa, and every real application/booking untouched. The 4
pending-approval applications never read or changed. liveMode /
submissionsPaused never flipped.

## Email 1 — Missing-info alert: PROVEN, landed in the inbox

- Dry run first: 20 gaps, subject preview, form link included.
- Real call: POST /api/v1/talent/:id/missing-info-alert → alerted:true,
  emailQueued:true, emailSent:true, **messageId 1a20a5ecb4298350**,
  notification ntf_4e61bafdcb4342a8.
- Inbox-confirmed (topteatalents@gmail.com, read via Gmail API):
  - Subject (verbatim): `Top Tea Talents — 20 details we need from you`
  - From topteatalents@gmail.com, to topteatalents@gmail.com.
  - Sent Mon, 23 Nov 2026 16:45:14 EST.
  - Body lists all 20 gaps (Gender … Close-up + full-body photos) and the
    reply option ("reply to this email with your answers").
- GET /api/v1/talent/:id/missing-info beforehand returned the question set:
  19 questions, 20 gaps (19 + photos) for the fresh talent.

## Email 2 — Submission snapshot (manual): PROVEN, landed in the inbox

- Call: POST /api/v1/applications/app_4a078509aee9434a/snapshot →
  snapshotEmailQueued:true, snapshotEmailSent:true,
  **messageId 1a20a5f1d8916175**.
- Inbox-confirmed:
  - Subject (verbatim): `Your submission receipt — TEST — Alerts Proof Print Role — Ref TTT-C62D1B10`
  - Sent Mon, 23 Nov 2026 16:45:34 EST.
  - Body: job, ref TTT-C62D1B10, status AWAITING APPROVAL, pay $500/day
    (per the posting), about-you summary, photos sent 0.
- Stored on the record: GET /api/v1/applications/:id shows snapshot_json
  (ref TTT-C62D1B10, source "manual", pay line, answers summary).
- List view: app1 carries only the small snapshotSummary (status,
  destination, submitVia, sentAt, messageId, source) — no full snapshot
  text. App2 (no snapshot) shows snapshotSummary null.

## Email 3 — Outcome accepted (full details): PROVEN, landed in the inbox

- Call: POST /api/v1/applications/app_4a078509aee9434a/outcome,
  outcome "accepted", fromName "Test Casting", details callTime "9:00 AM",
  eventDate "2026-12-03", location "Test Studio, Miami",
  whatToBring "ID + headshot", contact "casting@example.com",
  notes "Park in the back lot. TEST ONLY."
- Result: outcome recorded (accepted, outcomeAt 2026-11-23T21:45:49Z,
  details stored verbatim); booking created **bkg_2dcd943697b64633, BOOKED,
  gross $500, fee $61.10, net $438.90, eventDate 2026-12-03**;
  emailSent:true, **messageId 1a20a5f584085acb**.
- Inbox-confirmed:
  - Subject (verbatim): `You're booked! — TEST — Alerts Proof Print Role`
  - Sent Mon, 23 Nov 2026 16:45:50 EST.
  - Body carries exactly the supplied facts (call time, date, location,
    bring, contact, notes) — nothing invented.

## Email 4 — Outcome callback (ask quoted): PROVEN, landed in the inbox

- Call: POST /api/v1/applications/app_14044bae9e2b4f63/outcome,
  outcome "callback", fromName "Test Casting", details.ask "Can you come
  in for a callback on Friday? Please bring your portfolio. TEST ONLY."
- Result: outcome recorded (callback); **booking: none**; emailSent:true,
  **messageId 1a20a5f7bf83d28f**. Bookings total stayed 1 (only the
  accepted one).
- Inbox-confirmed:
  - Subject (verbatim): `Callback / questions from the agency — TEST — Alerts Proof Callback Role`
  - Sent Mon, 23 Nov 2026 16:45:59 EST.
  - Body quotes the ask verbatim. **No call time mentioned, none invented.**

## Answers round-trip: PROVEN

- Valid batch: POST /api/v1/talent/:id/answers
  {height "5'9", hairColor "Black", weightLbs 180, dateOfBirth "1990-05-15"}
  → ok:true, saved [height, hairColor, weightLbs, dateOfBirth],
  remaining gaps 20 → 16.
- On the record: height "5'9" top-level, hairColor "Black" top-level,
  weightLbs 180 in measurements, dateOfBirth 1990-05-15 in demographics,
  no nested `profile` key (the build's path fix holds live).
- Invalid batch: {hairColor "Purple", ethnicity "Black / African American"}
  → **HTTP 400 "Hair color: pick one of the listed options"**, and the
  good answer was NOT saved (ethnicity still null, hairColor still "Black").
  Atomicity holds live.
- Gotcha (mine, not a defect): height options are `5'9` with NO inch mark —
  `5'9"` is rejected. Use the exact option text from GET missing-info.

## Findings

1. **FORM LINK IN THE ALERT EMAIL 404s — real defect, needs a fix.**
   The live email's link is
   `https://top-tea-talents-api.onrender.com/#/complete-profile`.
   The API host returns 404 `{"ok":false,"error":"not found"}` at its root —
   it serves JSON, not the SPA. The server builds the link from the
   `PUBLIC_URL` env var, which on Render points at the API host itself.
   The reply-to fallback in the email still works, but the form link is
   dead until PUBLIC_URL is set to
   `https://moocho954-afk.github.io/top-tea-talents` (Render env change)
   or the builder defaults to the Pages origin. Not fixed here — needs the
   parent (env change) or a code change.
2. Registration side effect: creating the scratch talent queued a
   verification-code email to the agency inbox (**messageId
   1a20a5f0701a846b**, subject "TOP TEA TALENTS — verification code",
   16:45:29 EST). Expected — the scratch talent carried the agency email
   so the proof emails could land somewhere readable. Not a proof email.
3. Cleanup side effect: releasing the scratch booking before deleting it
   sent the release email (**messageId 1a20a607a781b32c**) to
   topteatalents@gmail.com. Expected — the release flow working as built.
4. **LEFTOVER: contacts row ctc_76b6de18d9bb35c8** — kind "talent", name
   "Test Proof", email topteatalents@gmail.com, phone 5550100999, 0
   applications, 0 bookings. Created by the register route's upsertContact.
   There is NO DELETE /api/v1/contacts endpoint (only GET + POST), so it
   cannot be removed via the API. Harmless directory row; needs a code
   change or a direct DB delete to clear.
5. NOT proven (same caveat as the build report): the email-SENT snapshot
   branch of the send handler. The manual snapshot was proven end-to-end;
   the sent branch calls the identical helpers with the same argument
   shape, but no real send fired during this proof (both scratch
   applications stayed AWAITING APPROVAL).

## Cleanup — all scratch records deleted, baseline confirmed

- Booking bkg_2dcd943697b64633: released (RELEASED) → deleted.
- Applications app_4a078509aee9434a + app_14044bae9e2b4f63: deleted.
- Opportunities test:alerts-proof-20261123 + test:alerts-proof-callback-20261123:
  deleted.
- Talent tal_29ff23899bc84502: deleted (photos/social/fast_track/guardians/
  consents/notifications/sessions/talent rows).
- Re-checked: talent, application, opportunity all return 404 ("not found").
- Live counts after cleanup: **4 talents / 435 opportunities / 19
  applications / 4 pending approval / 0 bookings / 6 notifications** —
  exactly the pre-proof baseline.
- No push, no deploy, no live-backend data touched beyond the scratch
  records above.
