# TOP TEA TALENTS — Wipe-Proof Ledger Mirror

## The problem
The backend stores everything in a SQLite file. On Render's free tier that
file is wiped on every redeploy, restart, or spin-down — and with it every
talent, consent, review, booking, and the ledger itself. Before this change
only the bundled seed came back. That is exactly the ReacheR wipe problem,
solved here with the same pattern (see the `wipe-proof-ledger` skill in
`~/workspace/custom-skills/wipe-proof-ledger/`).

## The pattern (in one paragraph)
The wipeable DB is a derived cache, never the source of truth. The source
of truth is an append-only, hash-chained event log kept outside the
wipeable store. On boot the server replays the log into a fresh DB before
serving. A wipe then costs one restart + a replay, not data loss.

## What was built (code only — nothing pushed or deployed yet)
- **`server/src/mirror.ts`** (new, ~700 lines):
  - `mirrorPathFor()` — the mirror lives next to the DB:
    `/data/top-tea-talents-mirror.jsonl` on Render,
    `./data/ledger-mirror.jsonl` locally, `/tmp/ttt-test-XXXXXX-mirror.jsonl`
    in selftest.
  - `appendMirror()` — every `ledgerAppend` also appends one JSONL line
    (the full ledger event + a `state` snapshot of the record after the
    change), fsync'd before the API call returns, serialised through an
    in-process queue. Each line carries its own chain (`mirror_prev` /
    `mirror_hash` over the whole line, state included) so tampering with
    state breaks verification just like tampering with data does.
  - `verifyMirrorFile()` — recomputes both chains (event hash + mirror
    hash), fails at the first bad seq, never silently skips.
  - `restoreFromMirror()` — replays a verified mirror into a fresh DB:
    ledger rows first (the chain survives the wipe), then each event's
    state (upserts; latest state wins; tombstones delete). Refuses an
    invalid chain outright.
  - `bootRestoreIfNeeded()` — runs after `SCHEMA`, before the seed check:
    restores only when the local ledger is empty (a wipe). If `MIRROR_URL`
    is set and no local mirror exists, fetches the durable copy, verifies
    it BEFORE writing it locally, then restores. Appends a `ledger.restore`
    event recording the restore. A tampered mirror is quarantined
    (`<mirror>.tampered-<timestamp>`, bytes kept for forensics) and a fresh
    mirror starts — appending to a broken chain would only make it worse.
  - `rebuildMirrorFromDb()` — repair path: regenerates the mirror from the
    live DB, re-attaching current state only to the latest event per
    entity (marked `state_rebuilt: true`).
- **`server/src/server.ts`** (wired, additive only):
  - `ledgerAppend(..., state?)` + `audit(..., state?)` — state is the full
    row the code just wrote (talent profile, consent row, review row,
    application row, booking row + its notification + queued email,
    fast-track, guardian, settings, source, cubicle, opportunity).
    Every mutation route passes state; ledger-only events pass null.
  - `GET /ledger/verify` now also returns `mirror: {exists, events,
    valid, first_bad_seq}`.
  - `GET /ledger/mirror` (admin) — the raw mirror, the durable artifact
    a collector pushes. `GET /ledger/mirror/verify` (admin).
    `POST /ledger/mirror/rebuild` (admin).
- **`server/selftest.sh`** — 73 base checks (grew with the v11 server:
  email verification, password reset, jobs-for-you, owner gate, per-talent
  portfolio links) + **14 mirror checks (87 total)**:
  (a) mirror file exists, one line per event, state carried, no secrets;
  (b) wipe simulation — delete the DB, keep the mirror, restart, zero loss;
  (c) tamper test — corrupt one line, wipe, restart, refusal + quarantine.
- **`prototype/ledger-mirror-recorder.yml`** — GitHub Actions workflow
  (5-min cron) that fetches the mirror from the live API and commits it
  to the `ledger` branch. PROTOTYPE — not activated (needs the owner's
  taps; steps in the file header).
- **`render.yaml`** — `MIRROR_URL` env var added (empty by default); the
  server reads the durable copy from it when the local mirror is gone.

## Live test evidence (2026-11-21/22, this VM)
Full selftest, re-run 2026-11-22 ~02:05 EST after the v11 server + test
sync landed in this package (server 1.1.0, 87 checks), run twice on two
ports, identical result:
```
SELFTEST: 87 passed, 0 failed
```
- Baseline 73/73 green (no regression); mirror checks 14/14 green.
- NOTE (diagnosed 02:05 EST): two runs on the default port first showed
  82/87 with 3 failures (verify-status, consent, rotation). Root cause
  was a stale test server orphaned on port 3457 by an interrupted run
  (a piped `| head` killed the script before its cleanup trap ran), so
  the new server could not bind and requests hit the stale server/DB.
  On a fresh port (3458) and again on 3457 with no orphan listening:
  87/87. Not a server defect — the server code is unchanged; the
  lesson is to never pipe the selftest through `head`.
- (a) Mirror: 12 lines for 12 ledger events at check time; register line
  carries `state.talent` (id + email); booking line carries
  `state.booking` (gross_cents matches the ledger data) + notification +
  email rows; no `password_hash` anywhere in the mirror; mirror verify
  endpoint valid; download admin-only (401 without token).
- (b) Wipe simulation: before = **12 ledger events, 1 talent, 1 booking**;
  DB files deleted, mirror kept, server restarted on the same
  `DATABASE_PATH`. After: **14 ledger events (12 restored + 1
  `ledger.restore` + 1 fresh `seed.import`), 1 talent, 1 booking, 423
  opportunities**; chain verifies; mirror events = 14, matching;
  talent profile restored at 100% / READY FOR MATCHING; booking money
  reconciles (gross − fee = net); notification restored. **Zero events
  lost.**
- (c) Tamper test: mirror line seq 3 corrupted (data changed, hashes
  NOT recomputed); DB wiped; restart. Result: **0 talents, 0 bookings**
  restored; ledger = 1 event (fresh `seed.import` only); live mirror =
  1 event, valid; server log contains `MIRROR REFUSED` +
  `MIRROR QUARANTINED`; tampered file preserved as
  `<mirror>.tampered-<timestamp>` with the tampered bytes intact.
- Rebuild endpoint verified live separately: mirror deleted → rebuild →
  `{rebuilt: true, events: 2, withState: 1, withoutState: 1}` → verify
  valid.

## What survives what (honest)
| Event | What comes back |
|---|---|
| DB file deleted/corrupted while the container lives | Everything in the mirror: talents, profiles, consents, reviews, applications, bookings (+ money), notifications, email queue, settings, sources, cubicles, opportunities added by staff, the ledger chain itself |
| Full Render restart (free tier, no Turso, recorder NOT activated) | **Seed only.** The mirror file lives on the same ephemeral filesystem as the DB — it dies with it. This is the honest limit until the recorder (below) or Turso is live. |
| Full Render restart with the recorder activated + `MIRROR_URL` set | Everything in the last recorded mirror (up to ~5 min old; GitHub raw lags minutes — the very latest events may be missing) |
| Full Render restart with Turso configured | Everything (the DB itself is durable) |
| Tampered mirror | Nothing from it — refusal + quarantine + seed-only boot |

## Known gaps (by design, same as ReacheR)
- **Passwords are never in the mirror.** A restored talent keeps their
  profile but has an empty password hash and must reset their password.
  The restore report lists them (`needsPasswordReset`). Password reset
  now exists as an endpoint (`POST /api/v1/auth/request-password-reset`
  + `POST /api/v1/auth/reset-password`, 6-digit code, hash-only,
  15-minute expiry) — that follow-up is DONE.
- **Owner passcode is never in the mirror either** (v11, same rule as
  passwords). After a wipe the owner passcode must be re-set from the
  staff view; agency earnings stay locked until then. The ledger row
  (`owner.passcode.set`) survives; the hash does not.
- **Verification/reset codes are never in the mirror.** The plaintext
  code is never stored anywhere (hash-only in the DB); after a wipe a
  talent simply requests a new code.
- **v11 restore coverage (added 2026-11-21):** `talent.email.verified`
  (profile), `talent.automation.save`, social-link begin/confirm/
  bio-checked/unlink, social-photo add/remove, `application.reply.record`,
  and `booking.complete` all replay from the mirror. Social-link and
  reply rebuild-from-DB (`POST /ledger/mirror/rebuild`) re-attaches no
  state for those rows (entity is the talent/application, not the row)
  — live appends carry the state; the repair path does not.
- **Sessions are never restored.** Tokens are secrets. Everyone logs in
  again after a wipe. Owner sessions likewise.
- **Photo bytes are never in the mirror.** The ledger event is restored;
  the photo itself is not — the talent re-uploads. Counted as a gap in
  every restore report, never silently skipped.
- **Board posts and board photo bytes are never in the mirror either (v16).**
  The mirror carries the board ledger events (`BOARD_POST_CREATED`,
  `BOARD_MENTION_DELIVERED`, `BOARD_POST_REPORTED`, `BOARD_POST_DELETED`,
  `BOARD_POST_REMOVED_BY_OWNER`) with ids + counts only — never post
  bodies or photo bytes. After a wipe the ledger rows restore, but the
  board posts themselves do not: they must be re-posted, same as
  portfolio photos. Stated in the UI and README, never promised otherwise.
- **Payment status** lives only in the ledger event (`booking.payment`
  data) — restored with the ledger rows, but there is no payments column
  (pre-existing design, unchanged).
- **The mirror is only as fresh as its last push.** Locally it is current
  on every append. Durably (GitHub) it is current only when the recorder
  runs — every 5 minutes once activated.

## Still owed (not in this task)
1. **Push** these files to GitHub (repo `moocho954-afk/top-tea-talents`) —
   the TTT deploy is mid-flight in a separate browser task; push sequencing
   happens after.
2. **Deploy** the new server code to Render (manual deploy — auto-deploy
   is off on purpose, so a push never wipes the DB).
3. **Activate the recorder** (owner taps in
   `prototype/ledger-mirror-recorder.yml` header + DEPLOY.md step 2b):
   create the `ledger` branch, add the `TTT_ADMIN_TOKEN` repo secret,
   copy the workflow into `.github/workflows/`, set `MIRROR_URL` in Render.
   Until then the mirror protects in-container DB loss only.
4. ~~Password-reset endpoint~~ — DONE in the v11 parity build
   (`POST /api/v1/auth/request-password-reset` +
   `POST /api/v1/auth/reset-password`; 6-digit code, hash-only,
   15-minute expiry, 5-attempt lock; TEST MODE shows the code once in
   the response because email is not connected).
5. TEST MODE is unchanged: submissions paused, nothing sent, no payments.
