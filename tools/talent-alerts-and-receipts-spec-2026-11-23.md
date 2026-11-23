# Talent alerts, submission snapshots & acceptance notifications — spec (owner order 2026-11-23 ~13:48 EST)

## The wall that started it
- Mona Lisa is compatible with Miami Vice (women, south-florida, $212/day ≥ her $100 floor, background extras) but BLOCKED: all 18 required answers missing + 0 photos on file. The submitter refuses with the exact gap list. Nobody told her — that's the wall. This package makes sure no talent ever sits blocked and silent again.

## 1. Missing-info alert (time-sensitive)
- Trigger: a talent is matched/eligible for a live opportunity but blocked by missing profile info (the submitter's gap list, or the matcher's eligibility gate), OR an application is package-ready but can't send for lack of info.
- Two channels, same alert:
  a. EMAIL to the talent (agency mailbox topteatalents@gmail.com): lists exactly what's missing. Every item is either MULTIPLE CHOICE (the form's real option list — e.g. haircut YES/NO/MAYBE, bathing suit, tattoos, overnights, paid fitting, vintage car, legal-to-work) or FILL-IN-THE-BLANK (DOB, weight, neck, sleeve, waist, inseam, jacket, dress/bra sizes, shoe, filming dates). She replies right back in that email with her answers; the reply lands in the agency mailbox (the reply-watch already monitors it every 30 min) and the agency records the answers to her profile.
  b. PROFILE ALERT: a banner/alert on her profile (#/talent/<id> + her dashboard) listing the same missing items; tapping it opens the same questions in-profile (multiple choice + blanks) so she can fill them there. Same storage path as the email replies.
- FORM, NOT A LIST (owner order 2026-11-23 ~13:56 EST — "like a form so it's user friendly and it's a easy flowing thing not a lot of typing only when needed"): the alert is a FORM, not a wall of text. Taps for every multiple-choice answer (the casting form's exact option lists), typing only where a number or date is needed (DOB, weight, sizes that are numbers). Easy questions first, sensitive ones near the end, one thing per question. BRIDGE (built 2026-11-23): a Google Form carries this today — "Top Tea Talents — Your details for Miami Vice (Mona-Lisa Dalmacy)", formId 1gBRQQsI7bJF-CyAISfUdV8QVmJ_Mo1mAjoef_zT85Yw, 20 questions, published + accepting responses, no sign-in required, link https://docs.google.com/forms/d/e/1FAIpQLSf8qdt2YMhbxJIRJDDWxQqZtp22hPkha-zcc1fDH_9Mtm_ASQ/viewform. The DURABLE version is the in-house TTT form (this package's build) — same questions, same flow, hosted on the talent's profile; the Google Form is retired for that talent once the in-house form lands.
- Storage: every answer she gives (email reply or in-profile) is written to her talent record (demographics/measurements/clothing/photos) and KEPT — "so this never happens again unless there's other information needed." New gaps only ever come from NEW requirements.
- Scope: every talent, every profile. Not a Mona Lisa one-off.

## 2. Submission snapshot email
- Trigger: an application is submitted (email sent OR form submitted).
- The talent gets an email with a SNAPSHOT of exactly what went out: the job, the reference code, the answers/photos sent, the destination (agency email or form link), date/time sent. For form submissions: a screenshot of the submitted form / confirmation.
- The snapshot is also stored on the application record so the agency can see it.

## 3. Acceptance / outcome notification (instant)
- Trigger: the agency replies to an application (reply-watch sees it in the inbox or the application-replies table, or staff records it) with an outcome — accepted / callback / rejected.
- The talent is notified INSTANTLY (email + profile notification): accepted → all the details from the agency's reply (call time, location/directions, what to bring, contact) populated in her profile (booking created/updated) AND emailed. Callback/questions → the same path with the agency's ask. Rejected → told plainly, no silence.
- The details come from the agency's reply — the system never invents call times, directions, or pay. If the reply lacks a detail, the notification says what's still to come, not a guess.
- "Instant" = the reply-watch (currently every 30 min) fires the notification on the same run it sees the reply; the acceptance path must not wait for the next daily cycle.

## 4. Submission-link storage
- For applications submitted on an external site (form/portal, e.g. TaylorMade's Tally form): the talent gets the link in her snapshot email so she can go back to it; the SAME link is stored on the application record for the agency, so the agency can go back and check for her.
- Applies to every portal submission, not just TaylorMade.

## Grounding (verified in code)
- Mailer: buildApplicationEmail (server.ts:2958) + queue + drainOneEmail + POST /email/drain. New builders (buildMissingInfoEmail, buildSubmissionSnapshotEmail, buildOutcomeEmail) reuse the same queue/drain.
- Reply-watch: cron ttt-reply-watch every 30 min checks topteatalents@gmail.com + moocho954@gmail.com + GET /api/v1/application-replies; alerts in WhatsApp. It is the detector for outcome replies.
- Talent profile: #/talent/<id> public page + dashboard; applications screen #/applications (screenApplications, app.js:1786). Alert banner goes on both.
- Submitter: tools/taylormade-form-submitter.py emits the gap list + fill-plan; the alert content IS that gap list (never re-derived by hand).
- Application statuses: SUBMITTED — SENT / PACKAGE READY / AWAITING APPROVAL (live verified 18 applications).

## Build order
- Queues behind the lyrics video, then the release button (one-by-one; order set by the owner: lyrics video → release button → this package, unless he re-orders).
- Builder scope: backend endpoints (missing-info alert trigger + in-profile answers endpoint + snapshot + outcome notification + link storage), 3 new email builders, frontend alert banner + in-profile form, reply-watch hookup for outcomes.

## Immediate action (today, before the system lands)
- Mona Lisa emailed manually 2026-11-23 with her exact 18 missing items (multiple choice + blanks) + the 2-photo request, from topteatalents@gmail.com; her reply lands in the agency mailbox and the reply-watch sees it. Her answers go on her record the moment they arrive.
