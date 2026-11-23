# TOP TEA TALENTS — Auto-Runner (v1.3.0)

**What it is:** a Muse cron that turns matched jobs into sent application
emails, automatically, for every READY talent whose automation is ON and
whose Fast-Track rules fit the job. It is the "system runs itself" loop
the owner ordered Nov 22.

**What it is NOT:** a backend schedule. The backend has no scheduler and
Render's free tier sleeps after 15 min idle, so the runner lives as a
cron instruction (this file) executed by a Muse agent turn. The backend
does the sending (Gmail transport + queue + drain); the cron does the
deciding.

## Cron to install (parent)

- **Name:** `ttt-auto-runner`
- **Schedule:** every 2 hours, 08:00–20:00 ET (08:00, 10:00, 12:00, 14:00,
  16:00, 18:00, 20:00). Runs land ~30 min after the listing sweep slots
  (08:00, 12:00, 16:00, 20:00) so new listings get picked up the same day.
- **Owner:** goal `top-tea-talents` (or the main chat if no goal owner).
- **Timeout:** 600s.
- **Job body (the instruction the cron agent follows):**

> You are the TOP TEA TALENTS auto-runner. Admin token: read it from the
> Secure Vault at run time (Render env var ADMIN_TOKEN; never write it
> to a file or a report). API: https://top-tea-talents-api.onrender.com.
> 1. GET /api/v1/health — if `live_mode` is false, STOP and report
>    "live mode off — nothing sent" (do not flip it; that is the owner's
>    tap). If `mail_configured` is false, STOP and report "mail not
>    configured — nothing sent".
> 2. GET /api/v1/settings — if `submissionsPaused` is true, STOP and
>    report "submissions paused — nothing sent".
> 3. GET /api/v1/talent (admin) — for each talent: GET
>    /api/v1/talent/:id/automation. SKIP unless `automation.enabled` is
>    true AND the talent's profile status is READY FOR MATCHING (GET
>    /api/v1/talent/:id). Mona-Lisa is skipped by this rule today
>    (automation OFF, no fast-track rules) — do NOT invent her inputs.
> 4. For each eligible talent: GET /api/v1/talent/:id/jobs-for-you.
>    Keep jobs with `automationEligible === true`.
> 5. Caps (per talent, per the owner's Fast-Track): 3/day, 10/week.
>    Count already-sent: GET /api/v1/applications?talentId=:id&status=
>    SUBMITTED — SENT, count rows with createdAt today (ET) and this
>    week (Mon–Sun ET). Send at most (3 − sentToday) and at most
>    (10 − sentThisWeek) this run.
> 6. For each job within caps, in the order Jobs For You returns them:
>    POST /api/v1/talent/:id/queue-selected {opportunityIds:[job]}.
>    For each created application: PATCH
>    /api/v1/applications/:appId/status {"status":"APPROVED"}, then POST
>    /api/v1/applications/:appId/send (admin, no dryRun).
>    - If the send returns `sent: true`, log it (ref code, Gmail message
>      id) — the ledger already records it.
>    - If it returns `packageReady: true`, log "PACKAGE READY — no
>      submission email on file; submit via the official link" and move
>      on. Never claim it was sent.
>    - If it returns `sent: false` with a reason, log the reason and
>      move on. The email stays queued; the server drain retries it.
> 7. POST /api/v1/email/drain (admin) once at the end.
> 8. Report to the main chat: per talent, sent (with ref codes),
>    package-ready, queued-with-reason, skipped (cap reached / no
>    eligible jobs). One line per talent, no hype. If nothing was
>    eligible, say so in one line.

## Guards (do not bypass)

- Never send for a talent whose automation is OFF or whose profile is
  not READY FOR MATCHING.
- Never exceed the caps. Never approve a job the match did not mark
  `automationEligible`.
- Never mark an application SUBMITTED — CONFIRMED by hand — the backend
  only allows that after a SENT email exists.
- Never flip `liveMode` or `submissionsPaused` from this job. Those are
  owner taps (the unpause happens only after the proof send works).
- Never invent a destination email. The send endpoint resolves it; a
  missing one is PACKAGE READY, not a failure to work around.

## Proof it works

After the first live run, the main chat should show at least one
`sent: true` line with a ref code and Gmail message id, and
GET /api/v1/ledger/verify should stay valid. If the run reports
"mail not configured", the sender is the blocker — see DEPLOY.md
"Live mode (v1.3.0)".
