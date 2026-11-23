# TTT Talent Alerts + Receipts — build report (v1.3.2)

Owner order 2026-11-23 ~13:48 EST. Built 2026-11-23, starting ~16:15 EST.
**Status: BUILT + VERIFIED LOCALLY. NOT pushed, NOT deployed, NO live writes,
NO real emails.** The live send proof comes after the parent pushes + deploys,
same pattern as the release button.

## What was built (spec sections 1–4)

### 1. Missing-info alert — email AND profile alert, in-house form
- **Question module (NEW): `server/src/missing-info-questions.ts` (70 lines).**
  33 questions with the casting form's EXACT option lists, captured from the
  live TaylorMade Miami Vice Tally form definition
  (`tools/taylormade-work/tal_a8e01279ace84ed4/fill-plan.json`,
  `live_questions` — the same source as the Google Form bridge). Includes
  `TAYLORMADE_MIAMI_VICE_DATES` (37 dates, exact form texts `"12/7 (MON)"`
  … `"2/6 (SAT)"`). Store convention per question: `"full"` (exact option
  text — the submitter matches by substring), `"short"` (text before
  `" — "`, i.e. YES/NO — the submitter checks these with `==`), `"bool"`
  (single checkbox → `true`), `"value"` (date/number/text).
- **Server helpers: `server/src/server.ts:2904–3027`** — `profileValue` /
  `setProfileValue` (read/write `demographics.*`, `measurements.*`,
  `clothing["…"]`, top-level fields), `questionApplies` (gender filter +
  `requires` conditionals), `isAnswered`, `filmingDateOptions`
  (Miami Vice 37 dates when `formSlug=miamivice` or the title contains
  "Miami Vice"; else the opportunity's `production_dates` tokens via
  `extractDateTokens`, formatted `"January 5, 2026"`; else free text),
  `computeMissingInfo`, `validateAnswer`, `storeAnswerValue`.
- **Endpoints (`server/src/server.ts:2098–2205`, talent block):**
  - `GET /api/v1/talent/:id/missing-info` — question set with exact options,
    answered/currentValue, and the gap list. `?opportunityId=` /
    `?formSlug=` steer the filming-dates options. Talent-or-admin.
  - `POST /api/v1/talent/:id/missing-info-alert` — admin. Email (exact gap
    list + in-profile form link when `PUBLIC_URL` is set + reply option)
    AND a profile notification. `dryRun: true` previews without sending.
    No gaps → `{alerted: false}` and nothing is sent.
  - `POST /api/v1/talent/:id/answers` — talent-or-admin. Validates EVERY
    answer against the question's exact option list (or date/number rules)
    FIRST; any invalid answer rejects the WHOLE batch and every error is
    reported — nothing is saved. Valid answers land on the record forever,
    in the exact fields the submitter reads. `english=YES` also adds
    `"English"` to `languages`.
- **Email builder: `buildMissingInfoEmail` (`server.ts:3522–3551`).**
- **Frontend:** route `#/complete-profile` (`frontend/app.js:300`);
  `screenCompleteProfile` (`app.js:1908–1977`) — one card per question, in
  the server's order (easy taps first, sensitive near the end); taps for
  choices, typing only for date/number/text; conditional cards appear only
  when their parent is YES (the server omits them otherwise — save a YES
  and the form re-loads with the follow-ups); the photos gap is a link-out
  card to `#/portfolio`, never a form question. Dashboard banner
  (`app.js:1100,1113–1122`) — fetched with the dashboard, prepended when
  gaps exist.

**Deliberate deviation from the spec's letter, in service of its intent:**
the spec says the profile alert goes on the talent's profile. The public
talent page (`screenPublicTalent`) is a PUBLIC portfolio — agencies would
see her gaps there. The banner is on the dashboard + the applications
screen (her own views) instead, never on the public page.

### 2. Submission snapshot email — exactly what went out
- **Storage: `server/src/schema.sql`** — applications gain `snapshot_json`,
  `submission_link`, `outcome`, `outcome_at`, `outcome_detail_json`
  (fresh-DB columns + idempotent `migrateAlertsV132`,
  `server.ts:377–389`, same catch-and-ignore pattern as the v1.3.1 migration).
- **Helpers: `storeSnapshot` + `sendSnapshotEmailToTalent`
  (`server.ts:3727–3771`).** The snapshot holds job, agency, ref code,
  status, destination + source, submit-via link, sent time, message id,
  pay line (from the listing), portfolio link, the "about you" summary,
  photos sent, the FULL sent email text, and the portal link. The full
  text lives on the record; the talent's email carries the summary.
- **Hookup in the send handler (`server.ts:2400–2445`):** snapshot stored
  + receipt emailed on the SENT branch and on the PACKAGE READY branch.
  Queued-but-unsent gets NO snapshot yet (nothing went out);
  `POST /applications/:id/snapshot` covers it later. A snapshot failure
  is caught and logged — it can never fail the send.
- **Endpoints (`server.ts:2515–2552`, applications block):**
  - `POST /api/v1/applications/:id/submission-link` (admin) — http(s) URL
    only; refreshes the stored snapshot with the link.
  - `POST /api/v1/applications/:id/snapshot` (admin) — rebuild + store +
    email the receipt to the talent.
  - `GET /api/v1/applications/:id` — the full record (snapshot, link,
    outcome). The LIST mapper now returns `applicationSummary`
    (`server.ts:3974–3988`) — submissionLink + outcome + outcomeAt + a
    SMALL snapshot summary, never the full snapshot (which holds the whole
    sent email text). `applicationView` (`server.ts:3960–3972`) is the full
    view used by the single-GET and the POST responses.
- **Email builder: `buildSubmissionSnapshotEmail` (`server.ts:3553–3583`).**
- **Frontend:** the applications card (`app.js:1876–1887`) shows the
  receipt line (status · destination · submission link · sent time), the
  portal link, and the outcome.
- **Submitter: `tools/taylormade-form-submitter.py`, `backend_log`
  (~lines 554–580).** After a live form submit is confirmed and the
  application is marked SUBMITTED — SENT, it POSTs the form URL to
  `/submission-link`, wrapped in try/except so a link-storage failure
  NEVER fails the submission log.

### 3. Instant acceptance notification — details FROM the reply, never invented
- **Endpoint: `POST /api/v1/applications/:id/outcome` (admin)
  (`server.ts:2554–2620`).** `outcome` ∈ accepted / callback / rejected.
  `details` (callTime, eventDate YYYY-MM-DD, location, whatToBring,
  contact, ask, notes — each ≤ 500 chars) + optional `replyId` (must belong
  to the application) + optional `fromName`. Records outcome + outcome_at
  + outcome_detail_json, then notifies the talent INSTANTLY: outcome email
  (drained inline, same pattern as the release flow) + profile
  notification. Accepted creates (or updates, never duplicates) the
  booking from the supplied facts only — gross/fee/net from the listing
  via the existing commission math, evidence = notes or the reply excerpt
  or `"Accepted per agency reply"`. Callback/rejected create no booking.
  A missing call time/location is reported as **"still to come"**, never
  guessed.
- **Email builder: `buildOutcomeEmail` (`server.ts:3585–3633`).**
- **Frontend:** admin outcome form on the replies screen
  (`app.js:1774–1783` markup, `1805–1838` wiring) — application ID,
  outcome select, from name, reply ID, call time, event date, location,
  what to bring, contact, the agency's ask, notes. The form text says
  "leave blank anything they did not say and it will be reported as still
  to come, never guessed."

### 4. Submission-link storage — emailed AND stored
Covered by the submission-link endpoint + snapshot + the submitter
`backend_log` patch above. The talent's receipt carries the link; the
applications screen shows it; the snapshot stores it.

## Bugs caught by testing and fixed (not silently substituted)
1. **Height/hairColor stored in the wrong place.** The module first pathed
   them `profile.height` / `profile.hairColor`, which writes a nested
   `profile` key inside the profile JSON. The submitter reads TOP-LEVEL
   `p.get("height")` / `p.get("hairColor")` — the answers would never have
   reached a submission. Fixed: paths are now `"height"` / `"hairColor"`.
   The test asserts the record holds them where the submitter reads them
   and that no nested `profile` key exists.
2. **`southFloridaResident` was kind `"choice"` with a single option** (a
   one-option select). It is now kind `"bool"` (the live form's single
   checkbox) with a `validateAnswer` bool branch; the frontend already
   rendered bool questions as a checkbox. `MissingInfoKind` now includes
   `"bool"`.

## Verification (all local, scratch only)
- `tsc --noEmit`: **clean** (via `bun x --package typescript tsc`;
  plain `npx tsc` pulls the wrong `tsc` package on this VM — use the bun
  form).
- `node --check frontend/app.js`: clean. `python3 -c ast.parse` on the
  submitter: clean.
- **`tools/alerts-receipts-test.py`: 87 passed, 0 failed — run TWICE.**
  Scratch server on :3103, fresh SQLite DB, `TTT_LIVE_MODE=true` (so the
  package-ready send branch runs). Scratch talents only, scratch
  opportunities, no real email — the mailer has no transport on scratch,
  so every drain reports `sent=false` and the tests assert on the QUEUED
  rows + stored records. Coverage: missing-info gaps for a Mona-Lisa-like
  sparse female profile (22 gaps: 21 questions + photos; men's sizes
  excluded by the gender filter; tattoo locations + car details hidden
  until the parent is YES; filming dates from opportunity dates, the 37
  Miami Vice dates, and free text); answers validation + atomicity
  (invalid batch saves nothing; bad multi option + good answer saves
  nothing; unknown question; wrong-talent 403; empty answers); the
  conditional appearing after `tattoos=YES`; the fill-all batch + 2 photo
  uploads → alert says nothing missing; alert dry-run + real (email
  queued, notification landed); submission link (bad URL 400, stored,
  non-admin 401); manual snapshot (stored, email queued, list carries
  summary only); package-ready send → snapshot stored with the full email
  text; queued-unsent send → NO snapshot stored; outcome accepted
  (booking created, $300 gross, email carries the agency's facts, no
  "still to come"), accepted again (same booking updated, no duplicate),
  accepted with no details ("still to come" line), callback (ask quoted,
  no invented call time, no booking), rejected (no booking), reply
  linkage, all six outcome guards; audit log carries all five new
  actions.
- **`tools/frontend-unit-test.cjs`: 43 passed, 0 failed** (was 35; +8 new
  v1.3.2 static checks: route, form screen, dashboard banner, applications
  receipt, replies outcome form, server endpoints + migration, schema
  columns, 33 questions / 37 dates, submitter link patch).
- **Regression: `tools/release-button-test.py`: 36 passed, 0 failed** (run
  against a scratch server on :3101 with `DATABASE_PATH=/tmp/ttt-release-test.db`
  — the test hardcodes that DB path for its direct-SQL seeds; running the
  server against any other DB makes the test fail on setup, which is a
  test-harness quirk, not a code regression).
- **Regression: `tools/booking-delete-test.py`: 20 passed, 0 failed.**
- The live submit path of the submitter was NOT executed (local Chromium
  has no egress — the live submit runs as a browser task, as before); the
  `backend_log` patch is verified statically by the frontend unit test
  and by reading the code.

## Exact rendered texts (from the scratch run — verbatim)
### Missing-info alert email
Subject: `Top Tea Talents — 20 details we need from you` (count = the gap
count for that profile)
```
Hello Test Printer,

We cannot submit you for new roles yet — the details below are missing from your profile.

- Gender
- Ethnic appearance
- Height
- Hair color
- Date of birth
- Weight (lbs)
- Shirt / blouse size
- Shoe size
- Hair cut / modification
- Facial hair
- Bathing suit / wardrobe comfort
- Tattoos
- Do you have a 1960–1989 car we can use for filming on set?
- Filming availability
- Paid fitting availability
- Are you okay with overnights or splits?
- You must be legal to work in the USA
- Miami / South Florida Native or Longtime Resident
- English language
- Close-up + full-body photos — upload them in your portfolio (2 photos: one close-up, one full body).

Or just reply to this email with your answers — we will put them on your profile the moment they arrive.
Once these are in, they stay on your record, so this never happens again unless a new role needs something new.

Thank you,
TOP TEA TALENTS — moocho954@gmail.com
```
(When `PUBLIC_URL` is set, a form link line appears after the list:
"Answer them here (mostly taps — typing only where a number or date is
needed): <PUBLIC_URL>#/complete-profile". On scratch there is no
`PUBLIC_URL`, so no link line rendered — the reply option is the fallback.)

### Submission snapshot email
Subject: `Your submission receipt — TEST — Print Role — Ref TTT-2AADF4DD`
```
Hello Test Printer,

Here is exactly what TOP TEA TALENTS sent for you:

Job: TEST — Print Role
Agency: Print Casting
Reference code: TTT-2AADF4DD
Status: AWAITING APPROVAL
Pay: $500/day (per the posting).
About you (as sent): South Florida. Categories: —. Skills: —. Experience: —.
Photos sent: 0

The full text we sent is stored on your application — ask the agency any time and we can show it to you.

Thank you,
TOP TEA TALENTS — moocho954@gmail.com
```
(This was a manual snapshot on an unsent application, so there is no
"Sent to:" line — that line appears only when an email actually went out.
On a real sent application the snapshot carries destination, sent time,
and message id.)

### Outcome email — accepted, full details
Subject: `You're booked! — TEST — Print Role`
```
Hello Test Printer,

Good news — Print Casting booked you for TEST — Print Role.

Call time: 9:00 AM
Date: 2026-12-03
Location: Test Studio, Miami
Bring: ID + headshot
Contact: casting@example.com
Notes: Park in the back lot.

Thank you,
TOP TEA TALENTS — moocho954@gmail.com
```

### Outcome email — accepted, NO details (the still-to-come case)
Subject: `You're booked! — TEST — Print Role 2`
```
Hello Test Printer,

Good news — Print Casting booked you for TEST — Print Role 2.


Still to come from the agency: call time, date, location, what to bring. We will send them the moment they arrive — nothing here is a guess.

Thank you,
TOP TEA TALENTS — moocho954@gmail.com
```

## What is NOT yet proven (needs push + deploy + live proof)
1. **A real Gmail send of any of the three new emails.** Scratch has no
   mail transport, so every drain honestly reported `sent=false`. The
   live proof (same pattern as the release button): scratch
   talent/opportunity/application/booking on the LIVE backend → alert +
   snapshot + outcome → confirm the three message ids in
   topteatalents@gmail.com / the talent mailbox. Do NOT run it against
   Joseph, Mona Lisa, or any real application.
2. **The email-SENT snapshot branch of the send handler.** The
   package-ready branch was exercised end-to-end on scratch (live mode
   on, no destination → snapshot stored + receipt queued). The sent
   branch calls the identical helpers with the same argument shape, but
   the actual Gmail send cannot happen on scratch, so the sent branch
   itself is unproven until the live proof in (1).
3. **A form-submission screenshot.** The mailer has no attachment support,
   so the server cannot capture, store, or email a screenshot of a
   submitted form. The snapshot carries the confirmation link + a note
   instead; the screenshot remains a manual step by the browser submitter.
   (Spec asked for one; this is the one part of the spec that cannot be
   built as written with the current mailer — stated here, not substituted.)
4. **The `#/complete-profile` screen in a live browser.** `node --check`
   + the unit tests cover the code; nobody has opened the screen and
   tapped through it yet. Same for the dashboard banner and the replies
   outcome form — they need a browser eyeball after deploy.
5. **The reply-watch → outcome hookup.** The endpoint exists and is
   tested; the cron that CALLS it is a proposed patch below, not applied.

## Proposed reply-watch cron-body patch (NOT applied — needs the owner's yes via the parent)
File: `~/workspace/cron.d/minutely/ttt-reply-watch__interval@30m.md`.
The cron file was NOT edited. Add a step 4b after the existing step 4
(record the reply), and extend step 5's alert:

> **4b. INSTANT OUTCOME (v1.3.2):** after a reply is recorded AND its
> outcome can be read from the reply itself (the agency says booked /
> callback / not selected, in their own words), call
> `ttt.py api POST /api/v1/applications/<id>/outcome --body
> '{"outcome":"accepted|callback|rejected","fromName":"<sender>","replyId":"<rpl_id>","details":{...only facts the reply states...}}'`.
> The endpoint emails + notifies the talent instantly. NEVER infer an
> outcome the reply does not state: a reply that only asks a question is
> a callback with the ask quoted verbatim; a reply that states a booking
> with no call time/location leaves those fields empty and the talent is
> told they are still to come. If the outcome cannot be read, record the
> reply only and alert the owner — do not call the outcome endpoint.
>
> Step 5's alert then also says the outcome was recorded and the talent
> notified (or that no outcome could be read, so only the reply was
> recorded).

## Guards — compliance
- No real email sent to any real agency or talent during the build. All
  verification on scratch servers + scratch DBs (wiped after each run).
- Joseph, Mona Lisa, and every real application/booking untouched. The 4
  pending-approval applications were not read or changed by any build
  step (the test only ever created scratch applications).
- `liveMode` / `submissionsPaused` never flipped on the live server (the
  scratch server ran with `TTT_LIVE_MODE=true` in its own process only).
- No deploy, no push, no user message. New files will show as drift
  until the parent pushes them (same as the release-button build).

## Files changed
- NEW `server/src/missing-info-questions.ts` (70 lines)
- NEW `tools/alerts-receipts-test.py` (449 lines)
- EDIT `server/src/schema.sql` (applications table +5 columns)
- EDIT `server/src/server.ts` (3,395 → 4,006 lines): import (:13),
  `migrateAlertsV132` (:377), talent endpoints (:2098–2205), applications
  endpoints (:2515–2620), question helpers (:2904–3027), mailer builders
  (:3518–3633), snapshot helpers (:3727–3771), `applicationView` /
  `applicationSummary` (:3960–3988), send-handler hookup (:2400–2445),
  list mappers → `applicationSummary`.
- EDIT `frontend/app.js` (2,568 → 2,698 lines): route (:300), dashboard
  banner (:1100, :1113–1122), replies outcome form (:1774–1783, :1805–1838),
  applications receipt card (:1876–1887), `screenCompleteProfile`
  (:1908–1977).
- EDIT `tools/taylormade-form-submitter.py` (`backend_log`, ~:554–580)
- EDIT `tools/frontend-unit-test.cjs` (+8 checks, 35 → 43)

## Next steps for the parent
1. Push the files (same browser-task route as the release button) + deploy.
2. Live Gmail proof (scratch talent only): missing-info alert, manual
   snapshot, outcome accepted/callback/rejected — confirm the three
   message ids landed, then delete the scratch records.
3. Browser eyeball of `#/complete-profile`, the dashboard banner, and the
   replies outcome form on the live site.
4. Get the owner's yes on the reply-watch cron-body patch above, then
   apply it.
